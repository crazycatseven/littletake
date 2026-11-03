import {fitReferenceScene} from '../framing.ts';
import {validateAsset} from '../../assets/model.ts';

// The experimental CPU solver must remain cancellable without blocking the editor or browser tools.
self.onmessage=event=>{
  const {scene,analysis,bindings,assets}=event.data;
  try{
    const result=fitReferenceScene(scene,analysis,bindings,true,assets.map(validateAsset),pass=>self.postMessage({progress:pass}));
    self.postMessage({scene:result});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:'Calibration failed.'});}
};
