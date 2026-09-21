'use strict';
(async () => {
  const requestedVersion = new URLSearchParams(location.search).get('v');
  const version = ['2','3'].includes(requestedVersion) ? `layers-v${requestedVersion}` : 'layers-v1';
  const base = `../assets/characters/white-dragon/${version}/`;
  const status = document.getElementById('status');
  try {
    const response = await fetch(base + 'manifest.json');
    if (!response.ok) throw new Error('无法读取分层清单');
    const manifest = await response.json();
    if (manifest.description) {
      document.getElementById('intro').textContent = manifest.description;
      document.getElementById('note').textContent = manifest.note || `${manifest.width} × ${manifest.height} · 五官分层素材 · 尚未绑定 Cubism。虹膜包含高光；四肢仍为整层。`;
    }
    document.getElementById('download').href = base + `white-dragon-${version}.psd`;
    document.getElementById('guide').href = base + 'README.md';
    const art = document.getElementById('art');
    art.style.aspectRatio = `${manifest.width}/${manifest.height}`;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox',`0 0 ${manifest.width} ${manifest.height}`);
    svg.setAttribute('aria-hidden','true');
    const definitions = document.createElementNS(ns,'defs');
    svg.append(definitions);
    art.append(svg);
    const controls = document.getElementById('layers');
    const spread = document.getElementById('spread');
    const referenceButton = document.getElementById('reference');
    const offsets = {tail:[160,20],'wing-left':[-170,-20],'wing-right':[170,-20],body:[0,80],'hair-left':[-120,-30],'hair-right':[120,-30],head:[0,-80],reference:[0,0]};
    let showReference = false;
    const entries = manifest.layers.map(layer => {
      const source = new Image();
      source.src = base + layer.file;
      const img = document.createElementNS(ns,'image');
      img.dataset.layer = layer.id;
      img.setAttribute('href',source.src);
      img.style.display = 'none';
      svg.append(img);
      const ready = source.decode().then(() => {
        img.setAttribute('width',source.naturalWidth);
        img.setAttribute('height',source.naturalHeight);
      });
      const entry = {layer,img,source,ready,checked:!layer.hidden};
      if (layer.id !== 'reference') {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = entry.checked;
        checkbox.addEventListener('change', () => {
          entry.checked = checkbox.checked;
          if (entry.checked && layer.variantGroup) entries.forEach(other => {
            if (other !== entry && other.layer.variantGroup === layer.variantGroup) {
              other.checked = other.checkbox.checked = !!layer.variant && other.layer.variant === layer.variant;
            }
          });
          render();
        });
        label.append(checkbox, document.createTextNode(layer.name.replace(/^\d+ /, '').replace(/（画面[左右]）/, '')));
        controls.append(label);
        entry.checkbox = checkbox;
      }
      return entry;
    });
    for (const entry of entries.filter(e=>e.layer.clipTo)) {
      const baseEntry = entries.find(e=>e.layer.id === entry.layer.clipTo);
      const mask = document.createElementNS(ns,'mask');
      mask.id = `mask-${entry.layer.id}`;
      mask.setAttribute('maskUnits','userSpaceOnUse');
      mask.setAttribute('x','0'); mask.setAttribute('y','0');
      mask.setAttribute('width',manifest.width); mask.setAttribute('height',manifest.height);
      mask.style.maskType = 'alpha';
      const maskImage = document.createElementNS(ns,'image');
      maskImage.setAttribute('href',base + baseEntry.layer.file);
      mask.append(maskImage); definitions.append(mask);
      entry.img.setAttribute('mask',`url(#${mask.id})`);
      entry.clip = {baseEntry,maskImage};
    }
    function render() {
      const amount = Number(spread.value) / 100;
      for (const {layer,img,checked,clip} of entries) {
        const hidden = layer.id === 'reference' ? !showReference : showReference || !checked || (clip && !clip.baseEntry.checked);
        img.style.display = hidden ? 'none' : '';
        const [dx,dy] = layer.explode || offsets[layer.id] || [0,-80];
        img.setAttribute('x',layer.left + dx * amount);
        img.setAttribute('y',layer.top + dy * amount);
        if (clip) {
          const base = clip.baseEntry;
          const [mx,my] = base.layer.explode || offsets[base.layer.id] || [0,-80];
          clip.maskImage.setAttribute('x',base.layer.left + mx * amount);
          clip.maskImage.setAttribute('y',base.layer.top + my * amount);
          clip.maskImage.setAttribute('width',base.source.naturalWidth);
          clip.maskImage.setAttribute('height',base.source.naturalHeight);
        }
      }
      spread.disabled = showReference;
      document.getElementById('spread-value').value = `${spread.value}%`;
      referenceButton.setAttribute('aria-pressed', String(showReference));
      referenceButton.textContent = showReference ? '返回分层' : '查看原画';
    }
    referenceButton.addEventListener('click', () => { showReference = !showReference; render(); });
    document.getElementById('background').addEventListener('click', event => {
      const light = document.querySelector('.stage').classList.toggle('light');
      event.currentTarget.setAttribute('aria-pressed', String(light));
      event.currentTarget.textContent = light ? '深色背景' : '浅色背景';
    });
    document.getElementById('restore').addEventListener('click', () => {
      showReference = false;
      spread.value = '0';
      entries.forEach(entry => { if (entry.checkbox) entry.checked = entry.checkbox.checked = !entry.layer.hidden; });
      render();
    });
    spread.addEventListener('input', render);
    await Promise.all(entries.map(entry => entry.ready));
    render();
    status.textContent = `${entries.filter(e=>e.layer.id !== 'reference').length} 个素材层 + 1 个原画对照层 · 部分表情层默认隐藏`;
  } catch (error) {
    status.textContent = '素材载入失败，请通过项目服务器打开此页。' + error.message;
  }
})();
