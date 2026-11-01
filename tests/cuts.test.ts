import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReferenceInput} from '../server/reference/analyze.ts';
const video={dataUrl:'data:video/mp4;base64,'+Buffer.from([0,0,0,16,...Buffer.from('ftyp'),0,0,0,0]).toString('base64'),duration:12,width:1280,height:720};
test('video input preserves valid ordered cut hints and rejects malformed times',()=>{
 assert.deepEqual(parseReferenceInput({video:{...video,cuts:[5.5,1.9,1.9,.05,11.95]},direction:''}).video.cuts,[1.9,5.5]);
 assert.throws(()=>parseReferenceInput({video:{...video,cuts:['1']},direction:''}),{code:'invalid_input'});
});
