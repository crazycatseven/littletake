import {createReferenceJobsProxy} from '../server/reference/jobs/proxy.ts';
export default {fetch:createReferenceJobsProxy(process.env)};
