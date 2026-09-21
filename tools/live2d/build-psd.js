'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { readPsd } = require('ag-psd');
const { packageLayers } = require('./package-layers');
const version = process.argv[2] || 'layers-v1';
assert(['layers-v1','layers-v2','layers-v3'].includes(version), 'Expected layers-v1, layers-v2 or layers-v3');
const previewOnly = process.argv.includes('--preview-only');
const directory = path.resolve(__dirname,'../../assets/characters/white-dragon',version);
const manifest = JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
let clippingBaseId;
const layers = manifest.layers.map(layer => {
  if (layer.clipTo) assert.equal(clippingBaseId,layer.clipTo,'PSD clipped layers must remain adjacent to their base in one stack');
  else clippingBaseId = layer.id;
  const png = PNG.sync.read(fs.readFileSync(path.join(directory,layer.file)));
  return {name:layer.name,left:layer.left,top:layer.top,hidden:!!layer.hidden,clipping:!!layer.clipTo,imageData:{width:png.width,height:png.height,data:new Uint8ClampedArray(png.data)}};
});
const result = packageLayers(manifest.width,manifest.height,layers);
const output = path.join(directory,`white-dragon-${version}.psd`);
const decoded = readPsd(result.psd,{useImageData:true,skipThumbnail:true});
const expected = layers.slice().reverse();
assert.equal(decoded.width,manifest.width);
assert.equal(decoded.height,manifest.height);
assert.equal(decoded.children.length,expected.length);
decoded.children.forEach((layer,index) => {
  const source = expected[index];
  assert.equal(layer.name,source.name);
  assert.equal(!!layer.hidden,source.hidden);
  assert.equal(!!layer.clipping,source.clipping);
  assert.equal(layer.left,source.left);
  assert.equal(layer.top,source.top);
  assert.deepEqual(layer.imageData.data,source.imageData.data);
});
// Validate before writing. Never replace a manually edited PSD.
if (!previewOnly) {
  if (fs.existsSync(output)) assert(fs.readFileSync(output).equals(result.psd),'Existing PSD differs: save manual edits separately before rebuilding');
  else fs.writeFileSync(output,result.psd,{flag:'wx'});
  assert(fs.readFileSync(output).equals(result.psd),'Saved PSD differs from verified bytes');
}
const preview = PNG.sync.write({width:manifest.width,height:manifest.height,data:Buffer.from(result.composite.data)});
fs.writeFileSync(path.join(directory,'composite-preview.png'),preview);
console.log(JSON.stringify({output:previewOnly?'preview only':output,width:decoded.width,height:decoded.height,layers:decoded.children.length,rgbaRoundTrip:'identical',bytes:result.psd.length},null,2));
