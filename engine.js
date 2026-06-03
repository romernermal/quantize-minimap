// engine.js – Image Quantizer + Minimap Pathfinder
// Quantization: olivierlesnicki/quantize (MMCQ) – integrated as plain JS
// Start point: (4,4)

(function () {
  'use strict';

  // Check if EasyStar loaded
  if (typeof EasyStar === 'undefined') {
    console.error('EasyStar.js not loaded. Pathfinding will not work.');
  }

  /* ─────────────── Constants ─────────────── */
  const MAX_DIM = 200;
  const START_POINT = { x: 4, y: 4 };

  /* ─────────────── DOM Elements ─────────────── */
  const fileA = document.getElementById('fileA');
  const fileB = document.getElementById('fileB');
  const fileC = document.getElementById('fileC');
  const swatchesContainer = document.getElementById('swatchesContainer');
  const canvas = document.getElementById('mainCanvas');
  const ctx = canvas.getContext('2d');
  const container = document.getElementById('canvasContainer');
  const zoomIndicator = document.getElementById('zoomIndicator');

  const statusA = document.getElementById('statusA');
  const statusB = document.getElementById('statusB');
  const statusC = document.getElementById('statusC');
  const statusPath = document.getElementById('statusPath');
  const dotA = document.getElementById('dotA');
  const dotB = document.getElementById('dotB');
  const dotC = document.getElementById('dotC');
  const dotPath = document.getElementById('dotPath');

  /* ─────────────── State ─────────────── */
  let gridWidth = 0, gridHeight = 0;
  let baseGrid = null, mergedGrid = null;
  let palette = [];
  let selectedWallColors = new Set();
  let imageAData = null, imageBData = null, imageCData = null;
  let targetPoint = null, currentPath = [];

  // Pan/Zoom
  let scale = 1, offsetX = 0, offsetY = 0;
  let isPanning = false, panStart = { x: 0, y: 0 };

  /* ─────────────── Utility functions ─────────────── */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('No file'));
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('File read error'));
      reader.readAsDataURL(file);
    });
  }

  function resizeImage(img, maxDim = MAX_DIM) {
    let w = img.width, h = img.height;
    if (w <= maxDim && h <= maxDim) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
      return c;
    }
    const ratio = Math.min(maxDim / w, maxDim / h);
    const newW = Math.floor(w * ratio), newH = Math.floor(h * ratio);
    const c = document.createElement('canvas');
    c.width = newW; c.height = newH;
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, newW, newH);
    return c;
  }

  function getPixelData(canvas) {
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  }

  /* ─────────────── MMCQ (olivierlesnicki/quantize) ─────────────── */
  function quantizeMMCQ(pixels, maxc) {
    // Based on https://github.com/olivierlesnicki/quantize – MIT License
    const SIGBITS = 5, RSHIFT = 8 - SIGBITS, MAX_ITER = 1000, FRACT = 0.75;
    const idx = (r, g, b) => (r << (2 * SIGBITS)) + (g << SIGBITS) + b;

    // Priority queue with comparator
    function PQ(comparator) {
      const data = [];
      let sorted = false;
      const sort = () => { if (!sorted) { data.sort(comparator); sorted = true; } };
      return {
        push: (o) => { data.push(o); sorted = false; },
        peek: (i) => { sort(); return i !== undefined ? data[i] : data[data.length - 1]; },
        pop: () => { sort(); return data.pop(); },
        size: () => data.length,
        map: (f) => data.map(f),
        debug: () => { sort(); return data.slice(); }
      };
    }

    // Color box
    class VBox {
      constructor(r1, r2, g1, g2, b1, b2, histogram) {
        this.r1 = r1; this.r2 = r2; this.g1 = g1; this.g2 = g2; this.b1 = b1; this.b2 = b2;
        this.histogram = histogram;
        this._vol = null; this._cnt = null; this._cntSet = false; this._avg = null;
      }
      volume(force) {
        if (!this._vol || force) this._vol = (this.r2 - this.r1 + 1) * (this.g2 - this.g1 + 1) * (this.b2 - this.b1 + 1);
        return this._vol;
      }
      count(force) {
        if (!this._cntSet || force) {
          let n = 0;
          for (let i = this.r1; i <= this.r2; i++)
            for (let j = this.g1; j <= this.g2; j++)
              for (let k = this.b1; k <= this.b2; k++)
                n += this.histogram[idx(i, j, k)] || 0;
          this._cntSet = true;
          this._cnt = n;
        }
        return this._cnt;
      }
      copy() {
        return new VBox(this.r1, this.r2, this.g1, this.g2, this.b1, this.b2, this.histogram);
      }
      avg(force) {
        if (!this._avg || force) {
          const mult = 1 << (8 - SIGBITS);
          let ntot = 0, rs = 0, gs = 0, bs = 0;
          for (let i = this.r1; i <= this.r2; i++)
            for (let j = this.g1; j <= this.g2; j++)
              for (let k = this.b1; k <= this.b2; k++) {
                const hval = this.histogram[idx(i, j, k)] || 0;
                ntot += hval;
                rs += hval * (i + 0.5) * mult;
                gs += hval * (j + 0.5) * mult;
                bs += hval * (k + 0.5) * mult;
              }
          this._avg = ntot
            ? [~~(rs / ntot), ~~(gs / ntot), ~~(bs / ntot)]
            : [~~(mult * (this.r1 + this.r2 + 1) / 2), ~~(mult * (this.g1 + this.g2 + 1) / 2), ~~(mult * (this.b1 + this.b2 + 1) / 2)];
        }
        return this._avg;
      }
      contains(pixel) {
        const rval = pixel[0] >> RSHIFT, gval = pixel[1] >> RSHIFT, bval = pixel[2] >> RSHIFT;
        return rval >= this.r1 && rval <= this.r2 &&
               gval >= this.g1 && gval <= this.g2 &&
               bval >= this.b1 && bval <= this.b2;
      }
    }

    // Median cut along the longest axis
    function medianCutApply(histo, vbox) {
      if (!vbox.count()) return;
      const rw = vbox.r2 - vbox.r1 + 1, gw = vbox.g2 - vbox.g1 + 1, bw = vbox.b2 - vbox.b1 + 1;
      const maxw = Math.max(rw, gw, bw);
      if (vbox.count() === 1) return [vbox.copy()];

      let total = 0;
      const partialsum = [], lookahead = [];
      let i, j, k, sum;

      if (maxw === rw) {
        for (i = vbox.r1; i <= vbox.r2; i++) {
          sum = 0;
          for (j = vbox.g1; j <= vbox.g2; j++)
            for (k = vbox.b1; k <= vbox.b2; k++)
              sum += histo[idx(i, j, k)] || 0;
          total += sum;
          partialsum[i] = total;
        }
      } else if (maxw === gw) {
        for (i = vbox.g1; i <= vbox.g2; i++) {
          sum = 0;
          for (j = vbox.r1; j <= vbox.r2; j++)
            for (k = vbox.b1; k <= vbox.b2; k++)
              sum += histo[idx(j, i, k)] || 0;
          total += sum;
          partialsum[i] = total;
        }
      } else {
        for (i = vbox.b1; i <= vbox.b2; i++) {
          sum = 0;
          for (j = vbox.r1; j <= vbox.r2; j++)
            for (k = vbox.g1; k <= vbox.g2; k++)
              sum += histo[idx(j, k, i)] || 0;
          total += sum;
          partialsum[i] = total;
        }
      }
      for (let idx = 0; idx < partialsum.length; idx++) {
        if (partialsum[idx] !== undefined) lookahead[idx] = total - partialsum[idx];
      }

      function doCut(color) {
        const dim1 = color + '1', dim2 = color + '2';
        for (let i = vbox[dim1]; i <= vbox[dim2]; i++) {
          if (partialsum[i] > total / 2) {
            const vbox1 = vbox.copy(), vbox2 = vbox.copy();
            const left = i - vbox[dim1], right = vbox[dim2] - i;
            let d = left <= right
              ? Math.min(vbox[dim2] - 1, ~~(i + right / 2))
              : Math.max(vbox[dim1], ~~(i - 1 - left / 2));
            while (!partialsum[d]) d++;
            let count2 = lookahead[d];
            while (!count2 && partialsum[d - 1]) count2 = lookahead[--d];
            vbox1[dim2] = d;
            vbox2[dim1] = d + 1;
            return [vbox1, vbox2];
          }
        }
      }

      return maxw === rw ? doCut('r') : maxw === gw ? doCut('g') : doCut('b');
    }

    // Build histogram
    const histo = {};
    pixels.forEach(p => {
      const rval = p[0] >> RSHIFT, gval = p[1] >> RSHIFT, bval = p[2] >> RSHIFT;
      const k = idx(rval, gval, bval);
      histo[k] = (histo[k] || 0) + 1;
    });

    // Initial box covering all present colors
    const ks = Object.keys(histo);
    let rmin = Infinity, rmax = 0, gmin = Infinity, gmax = 0, bmin = Infinity, bmax = 0;
    ks.forEach(k => {
      const ki = +k;
      const r = ki >> (2 * SIGBITS), g = (ki >> SIGBITS) & 0x1f, b = ki & 0x1f;
      if (r < rmin) rmin = r; if (r > rmax) rmax = r;
      if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      if (b < bmin) bmin = b; if (b > bmax) bmax = b;
    });

    const vbox = new VBox(rmin, rmax, gmin, gmax, bmin, bmax, histo);
    const pq = PQ((a, b) => a.count() - b.count());
    pq.push(vbox);

    function iter(lh, target) {
      let ncolors = lh.size(), niters = 0;
      while (niters < MAX_ITER) {
        if (ncolors >= target) return;
        niters++;
        const v = lh.pop();
        if (!v.count()) { lh.push(v); continue; }
        const vs = medianCutApply(histo, v);
        if (!vs) { lh.push(v); continue; }
        lh.push(vs[0]);
        if (vs[1]) { lh.push(vs[1]); ncolors++; }
      }
    }

    iter(pq, FRACT * maxc);

    const pq2 = PQ((a, b) => a.count() * a.volume() - b.count() * b.volume());
    pq.map(v => pq2.push(v));
    iter(pq2, maxc - pq.size());

    const boxes = pq2.debug();
    const palette = boxes.map(b => b.avg());
    const mapColor = (pixel) => {
      for (const box of boxes) {
        if (box.contains(pixel)) return box.avg();
      }
      // Fallback to nearest
      let bestDist = Infinity, best = boxes[0].avg();
      for (const box of boxes) {
        const a = box.avg();
        const d = Math.hypot(pixel[0] - a[0], pixel[1] - a[1], pixel[2] - a[2]);
        if (d < bestDist) { bestDist = d; best = a; }
      }
      return best;
    };

    return { palette, map: mapColor };
  }

  /* ─────────────── Quantize to 3 colors (uses MMCQ) ─────────────── */
  function quantizeTo3Colors(imgCanvas) {
    const w = imgCanvas.width, h = imgCanvas.height;
    const data = getPixelData(imgCanvas);
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    const { palette: p, map: mapper } = quantizeMMCQ(pixels, 3);
    // Ensure exactly 3 palette entries (MMCQ may produce fewer if image has <3 colors)
    while (p.length < 3) p.push([0, 0, 0]);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w; outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
    const outImgData = outCtx.createImageData(w, h);
    const out = outImgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const mapped = mapper([data[i], data[i + 1], data[i + 2]]);
      out[i] = mapped[0]; out[i + 1] = mapped[1]; out[i + 2] = mapped[2]; out[i + 3] = 255;
    }
    outCtx.putImageData(outImgData, 0, 0);
    return { palette: p, quantizedCanvas: outCanvas };
  }

  /* ─────────────── Grid & wall logic ─────────────── */
  function buildBaseGrid(quantCanvas, pal, wallIdxSet) {
    const w = quantCanvas.width, h = quantCanvas.height;
    const data = getPixelData(quantCanvas);
    const grid = Array.from({ length: h }, () => new Array(w).fill(0));
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      let idx = pal.findIndex(c => c[0] === r && c[1] === g && c[2] === b);
      if (idx === -1) idx = 0; // fallback
      const pixelIdx = i / 4;
      const x = pixelIdx % w, y = Math.floor(pixelIdx / w);
      if (wallIdxSet.has(idx)) grid[y][x] = 1;
    }
    return grid;
  }

  function mergeImageBWalls(base, imgBCanvas) {
    const w = imgBCanvas.width, h = imgBCanvas.height;
    if (w !== gridWidth || h !== gridHeight) throw new Error('Image B dimensions mismatch');
    const data = getPixelData(imgBCanvas);
    const newGrid = base.map(row => [...row]);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) {
        const x = (i / 4) % w, y = Math.floor((i / 4) / w);
        newGrid[y][x] = 1;
      }
    }
    return newGrid;
  }

  function findBrightestPixel(imgCCanvas) {
    const w = imgCCanvas.width, h = imgCCanvas.height;
    const data = getPixelData(imgCCanvas);
    let maxB = -1, bx = 0, by = 0;
    for (let i = 0; i < data.length; i += 4) {
      const bright = data[i] + data[i + 1] + data[i + 2];
      if (bright > maxB) {
        maxB = bright;
        bx = (i / 4) % w;
        by = Math.floor((i / 4) / w);
      }
    }
    return { x: bx, y: by };
  }

  /* ─────────────── Swatches UI ─────────────── */
  function updateSwatches(pal) {
    swatchesContainer.innerHTML = '<span class="swatches-label">Walls:</span>';
    pal.forEach((color, idx) => {
      const hex = `rgb(${color[0]},${color[1]},${color[2]})`;
      const div = document.createElement('div');
      div.className = 'swatch-item' + (selectedWallColors.has(idx) ? ' selected-wall' : '');
      div.innerHTML = `
        <div class="swatch-color" style="background:${hex};"></div>
        <input type="checkbox" id="swatch-${idx}" ${selectedWallColors.has(idx) ? 'checked' : ''}>
        <label class="swatch-label-text" for="swatch-${idx}">Wall</label>
      `;
      const cb = div.querySelector('input');
      cb.addEventListener('change', (e) => {
        if (e.target.checked) selectedWallColors.add(idx);
        else selectedWallColors.delete(idx);
        div.classList.toggle('selected-wall', e.target.checked);
        recomputeAll();
      });
      swatchesContainer.appendChild(div);
    });
  }

  /* ─────────────── Pathfinding ─────────────── */
  function findPath() {
    return new Promise((resolve, reject) => {
      if (typeof EasyStar === 'undefined') return reject(new Error('EasyStar not loaded'));
      if (!mergedGrid || !targetPoint) return reject(new Error('Missing grid/target'));
      if (START_POINT.x < 0 || START_POINT.x >= gridWidth || START_POINT.y < 0 || START_POINT.y >= gridHeight)
        return reject(new Error('Start out of bounds'));
      if (mergedGrid[START_POINT.y][START_POINT.x] === 1) return reject(new Error('Start is wall'));
      if (mergedGrid[targetPoint.y][targetPoint.x] === 1) return reject(new Error('Target is wall'));

      const easystar = new EasyStar.js();
      easystar.setGrid(mergedGrid);
      easystar.setAcceptableTiles([0]);
      easystar.enableDiagonals(false);
      easystar.enableCornerCutting(false);

      easystar.findPath(START_POINT.x, START_POINT.y, targetPoint.x, targetPoint.y, (path) => {
        if (path === null) reject(new Error('No path found'));
        else resolve(path);
      });
      easystar.calculate();
    });
  }

  /* ─────────────── Main recompute ─────────────── */
  async function recomputeAll() {
    if (!imageAData) {
      resetGrid();
      updateStatus('path', 'awaiting Image A', 'neutral');
      render();
      return;
    }
    try {
      if (!window._cachedQuantizedA || imageAData._dirty) {
        const resizedA = resizeImage(imageAData);
        const { palette: pal, quantizedCanvas } = quantizeTo3Colors(resizedA);
        palette = pal;
        window._cachedQuantizedA = quantizedCanvas;
        imageAData._dirty = false;
        const newSet = new Set();
        for (let i = 0; i < palette.length; i++) if (selectedWallColors.has(i)) newSet.add(i);
        selectedWallColors = newSet;
        updateSwatches(palette);
      }
      const qCanvas = window._cachedQuantizedA;
      gridWidth = qCanvas.width; gridHeight = qCanvas.height;

      baseGrid = buildBaseGrid(qCanvas, palette, selectedWallColors);
      mergedGrid = baseGrid.map(row => [...row]);

      if (imageBData) {
        const resizedB = resizeImage(imageBData, MAX_DIM);
        if (resizedB.width !== gridWidth || resizedB.height !== gridHeight)
          throw new Error('Image B dimensions mismatch');
        mergedGrid = mergeImageBWalls(mergedGrid, resizedB);
        updateStatus('B', 'loaded & merged', 'good');
      } else {
        updateStatus('B', 'not loaded', 'neutral');
      }

      if (imageCData) {
        const resizedC = resizeImage(imageCData, MAX_DIM);
        if (resizedC.width !== gridWidth || resizedC.height !== gridHeight)
          throw new Error('Image C dimensions mismatch');
        targetPoint = findBrightestPixel(resizedC);
        updateStatus('C', `target (${targetPoint.x},${targetPoint.y})`, 'good');
      } else {
        targetPoint = null;
        updateStatus('C', 'not loaded', 'neutral');
      }

      if (targetPoint && mergedGrid) {
        try {
          const path = await findPath();
          currentPath = path;
          updateStatus('path', `found (${path.length} steps)`, 'good');
        } catch (e) {
          currentPath = [];
          updateStatus('path', e.message, 'error');
        }
      } else {
        currentPath = [];
        updateStatus('path', 'awaiting target', 'neutral');
      }

      fitGridToView();
      render();
      updateStatus('A', 'quantized', 'good');
    } catch (e) {
      console.error(e);
      updateStatus('path', e.message, 'error');
      render();
    }
  }

  function resetGrid() {
    baseGrid = null; mergedGrid = null; targetPoint = null; currentPath = [];
    palette = []; selectedWallColors.clear();
    window._cachedQuantizedA = null;
    updateSwatches([]);
    gridWidth = 0; gridHeight = 0;
  }

  /* ─────────────── Status & Rendering ─────────────── */
  function updateStatus(which, text, dotClass) {
    const el = which === 'A' ? statusA : which === 'B' ? statusB : which === 'C' ? statusC : statusPath;
    const dot = which === 'A' ? dotA : which === 'B' ? dotB : which === 'C' ? dotC : dotPath;
    el.textContent = text;
    dot.className = 'status-dot ' + (dotClass || 'neutral');
  }

  function fitGridToView() {
    if (!gridWidth || !gridHeight) return;
    const cw = container.clientWidth, ch = container.clientHeight;
    scale = Math.min(cw / gridWidth, ch / gridHeight, 4);
    offsetX = (cw - gridWidth * scale) / 2;
    offsetY = (ch - gridHeight * scale) / 2;
  }

  function render() {
    const cw = container.clientWidth, ch = container.clientHeight;
    canvas.width = cw; canvas.height = ch;
    ctx.clearRect(0, 0, cw, ch);
    if (!mergedGrid || !gridWidth || !gridHeight) {
      ctx.fillStyle = '#0d0d1a'; ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = '#555'; ctx.font = '14px sans-serif';
      ctx.fillText('Upload Image A to begin', 20, 40);
      return;
    }
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        ctx.fillStyle = mergedGrid[y][x] === 1 ? '#3a2a3a' : '#e8e8e8';
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.fillStyle = '#00cc66'; ctx.fillRect(START_POINT.x, START_POINT.y, 1, 1);
    if (targetPoint) { ctx.fillStyle = '#4488ff'; ctx.fillRect(targetPoint.x, targetPoint.y, 1, 1); }
    if (currentPath.length) {
      ctx.fillStyle = '#ffcc00';
      currentPath.forEach(p => ctx.fillRect(p.x, p.y, 1, 1));
    }
    if (scale >= 8) {
      ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      for (let x = 0; x <= gridWidth; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, gridHeight); }
      for (let y = 0; y <= gridHeight; y++) { ctx.moveTo(0, y); ctx.lineTo(gridWidth, y); }
      ctx.stroke();
    }
    ctx.restore();
    zoomIndicator.textContent = Math.round(scale * 100) + '%';
  }

  /* ─────────────── Pan & Zoom ─────────────── */
  function eventPos(e) { return { x: e.clientX, y: e.clientY }; }
  container.addEventListener('mousedown', e => {
    if (e.button === 0) {
      isPanning = true; panStart = eventPos(e);
      container.classList.add('grabbing'); e.preventDefault();
    }
  });
  window.addEventListener('mousemove', e => {
    if (!isPanning) return;
    const pos = eventPos(e);
    offsetX += pos.x - panStart.x; offsetY += pos.y - panStart.y;
    panStart = pos; render(); e.preventDefault();
  });
  window.addEventListener('mouseup', () => {
    if (isPanning) { isPanning = false; container.classList.remove('grabbing'); }
  });
  container.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const wx = (mx - offsetX) / scale, wy = (my - offsetY) / scale;
    scale = Math.min(Math.max(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.2), 30);
    offsetX = mx - wx * scale; offsetY = my - wy * scale;
    render();
  });
  window.addEventListener('resize', render);

  /* ─────────────── File inputs ─────────────── */
  fileA.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const img = await loadImage(f); imageAData = img; imageAData._dirty = true;
      selectedWallColors.clear();
      updateStatus('A', 'loaded', 'good'); await recomputeAll();
    } catch (err) { updateStatus('A', 'error', 'error'); }
  });
  fileB.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) { imageBData = null; updateStatus('B', 'not loaded', 'neutral'); await recomputeAll(); return; }
    try {
      imageBData = await loadImage(f); updateStatus('B', 'loaded', 'good');
      await recomputeAll();
    } catch (err) { updateStatus('B', 'error', 'error'); }
  });
  fileC.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) { imageCData = null; updateStatus('C', 'not loaded', 'neutral'); await recomputeAll(); return; }
    try {
      imageCData = await loadImage(f); updateStatus('C', 'loaded', 'good');
      await recomputeAll();
    } catch (err) { updateStatus('C', 'error', 'error'); }
  });

  /* ─────────────── Initial ─────────────── */
  resetGrid(); render();
  updateStatus('A', 'not loaded', 'neutral');
  updateStatus('B', 'not loaded', 'neutral');
  updateStatus('C', 'not loaded', 'neutral');
  updateStatus('path', 'ready', 'neutral');
})();
