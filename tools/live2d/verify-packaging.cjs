const test = require('node:test');
const assert = require('node:assert/strict');
const { readPsd } = require('ag-psd');
const { packageLayers } = require('./package-layers');

test('PSD preserves layer order, offsets, RGBA and hidden references after round trip', () => {
  const pixel = { width:1, height:1, data:new Uint8ClampedArray([10,20,30,128]) };
  const result = packageLayers(3,3,[
    { name:'龙尾', left:1, top:1, imageData:pixel },
    { name:'身体', left:1, top:1, imageData:{...pixel,data:new Uint8ClampedArray([200,100,50,255])} },
    { name:'原画对照', left:0, top:0, hidden:true, imageData:pixel },
  ]);
  const document = readPsd(result.psd, {useImageData:true,skipThumbnail:true});
  assert.deepEqual(document.children.map(l=>l.name),['原画对照','身体','龙尾']);
  assert.equal(document.children[0].hidden,true);
  assert.deepEqual(Array.from(document.children[2].imageData.data),[10,20,30,128]);
  assert.equal(document.children[2].left,1);
  assert.equal(document.children[2].top,1);
  assert.deepEqual(Array.from(document.imageData.data.slice(16,20)),[200,100,50,255]);
  assert.equal(document.imageData.data[3],0);
});

test('refuses an out-of-canvas layer instead of silently clipping artwork', () => {
  assert.throws(()=>packageLayers(2,2,[{name:'head',left:2,top:0,imageData:{width:1,height:1,data:new Uint8ClampedArray(4)}}]),/outside/);
});

test('iris clips to the eye white while preserving original layer pixels', () => {
  const white = {width:2,height:1,data:new Uint8ClampedArray([255,255,255,255,255,255,255,0])};
  const iris = {width:2,height:1,data:new Uint8ClampedArray([20,80,200,255,20,80,200,255])};
  const result = packageLayers(3,2,[
    {name:'eye white',left:1,top:1,imageData:white},
    {name:'iris',left:1,top:1,clipping:true,imageData:iris}
  ]);
  const doc = readPsd(result.psd,{useImageData:true,skipThumbnail:true});
  assert.equal(doc.children[0].clipping,true);
  assert.deepEqual(doc.children[0].imageData.data,iris.data);
  assert.deepEqual(Array.from(result.composite.data.slice(16,20)),[20,80,200,255]);
  assert.equal(result.composite.data[23],0);
});
