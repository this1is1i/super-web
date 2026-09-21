'use strict';
const assert = require('node:assert/strict');
const { writePsdBuffer, initializeCanvas } = require('ag-psd');

// Raw RGBA allocation keeps this offline packer independent of native canvas.
initializeCanvas(
  () => { throw new Error('Canvas rendering is not used by this packer'); },
  (width, height) => ({width, height, data:new Uint8ClampedArray(width * height * 4)})
);

// Format packaging only: preserve every layer's RGBA bytes; use integer placement.
// Input ordering is back-to-front, while PSD children are front-to-back.
function packageLayers(width, height, layers) {
  assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
  const composite = { width, height, data:new Uint8ClampedArray(width * height * 4) };
  const names = new Set();
  let clipBase;
  for (const layer of layers) {
    const { imageData:source, left=0, top=0 } = layer;
    assert(layer.name && !names.has(layer.name), 'Layer names must be unique');
    names.add(layer.name);
    assert(source && source.data.length === source.width * source.height * 4, 'Expected RGBA');
    assert(Number.isInteger(left) && Number.isInteger(top) && left >= 0 && top >= 0 &&
      left + source.width <= width && top + source.height <= height, 'Layer outside canvas');
    if (layer.clipping) assert(clipBase, 'Clipping layer requires a base below it');
    else clipBase = layer;
    if (layer.hidden) continue;
    for (let y=0;y<source.height;y++) for (let x=0;x<source.width;x++) {
      const si = (y * source.width + x) * 4;
      const di = ((y + top) * width + x + left) * 4;
      let sa = source.data[si+3] / 255;
      if (layer.clipping) {
        const mx = x + left - (clipBase.left || 0);
        const my = y + top - (clipBase.top || 0);
        const mask = clipBase.imageData;
        sa *= !clipBase.hidden && mx >= 0 && my >= 0 && mx < mask.width && my < mask.height
          ? mask.data[(my * mask.width + mx) * 4 + 3] / 255 : 0;
      }
      if (!sa) continue;
      const da = composite.data[di+3] / 255;
      const alpha = sa + da * (1-sa);
      for (let c=0;c<3;c++) composite.data[di+c] = Math.round((source.data[si+c]*sa + composite.data[di+c]*da*(1-sa))/alpha);
      composite.data[di+3] = Math.round(alpha*255);
    }
  }
  const psd = writePsdBuffer({width,height,imageData:composite,children:layers.slice().reverse()}, {noBackground:true,generateThumbnail:false});
  return {psd,composite};
}
module.exports = {packageLayers};
