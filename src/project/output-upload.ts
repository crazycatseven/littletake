import { projectOutputSchema, type ProjectOutput } from './room';

export interface OutputTransfer {
  phase: 'uploading' | 'saving' | 'failed';
  loaded: number;
  total: number;
  error?: string;
}

/** Upload progress measures bytes sent; only the server response confirms a saved file. */
export function uploadOutput(url: string, headers: Record<string, string>, data: Blob, progress: (state: OutputTransfer) => void): Promise<ProjectOutput> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.responseType = 'json';
    request.timeout = 600_000;
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = event => progress({ phase: 'uploading', loaded: event.loaded, total: event.lengthComputable ? event.total : data.size });
    request.upload.onload = () => progress({ phase: 'saving', loaded: data.size, total: data.size });
    request.onerror = () => reject(new Error('Connection interrupted. Keep this page open and retry.'));
    request.ontimeout = () => reject(new Error('Upload timed out. Keep this page open and retry.'));
    request.onabort = () => reject(new Error('Upload interrupted. Retry to send this image again.'));
    request.onload = () => {
      const value = request.response;
      if (request.status < 200 || request.status >= 300) {
        reject(Object.assign(new Error(value?.error?.message ?? 'The server could not save this file. Retry the upload.'), { code: value?.error?.code }));
        return;
      }
      const result = projectOutputSchema.safeParse(value);
      if (!result.success) { reject(new Error('The server did not confirm this file was saved. Retry the upload.')); return; }
      resolve(result.data);
    };
    progress({ phase: 'uploading', loaded: 0, total: data.size });
    request.send(data);
  });
}
