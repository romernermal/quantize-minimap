// engine.js – Image Quantizer + Minimap Pathfinder
// Updated: start point (4,4), willReadFrequently, EasyStar fallback check

(function () {
  'use strict';

  // Check if EasyStar loaded
  if (typeof EasyStar === 'undefined') {
    console.error('EasyStar.js not loaded. Pathfinding will not work.');
    // We can still continue, but pathfinding will fail gracefully.
  }

  /* ─────────────── Constants ─────────────── */
  const MAX_DIM = 200;          // max width/height for performance
  const START_POINT = { x: 4, y: 4 };  // changed from 8,8

  /* ─────────────── DOM Elements ─────────────── */
  const fileA = document.getElementById('fileA');
  const fileB = document.getElementById('fileB');
  const fileC = document.getElementById('fileC');
  const swatchesContainer = document.getElementById('swatchesContainer');
  const canvas = document.getElementById('mainCanvas');
  const ctx = canvas.getContext('2d');
  const container = document.getElementById('canvasContainer');
  const zoomIndicator = document.getElementById('zoomIndicator');

  // Status elements
  const statusA = document.getElementById('statusA');
  const statusB = document.getElementById('statusB');
  const statusC = document.getElementById('statusC');
  const statusPath = document.getElementById('statusPath');
  const dotA = document.getElementById('dotA');
  const dotB = document.getElementById('dotB');
  const dotC = document.getElementById('dotC');
  const dotPath = document.getElementById('dotPath');

  /* ─────────────── State ─────────────── */
  let gridWidth = 0;
  let gridHeight = 0;
  let baseGrid = null;
  let mergedGrid = null;
  let palette = [];
  let selectedWallColors = new Set();
  let imageAData = null;
  let imageBData = null;
  let imageCData = null;
  let targetPoint = null;
  let currentPath = [];

  // Pan/Zoom
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };

  /* ─────────────── Utility functions ─────────────── */

  /** Load image from file, return HTMLImageElement */
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

  /** Resize an image to max dimensions MAX_DIM, returns canvas with willReadFrequently set */
  function resizeImage(img, maxDim = MAX_DIM) {
    let w = img.width;
    let h = img.height;
    if (w <= maxDim && h <= maxDim) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return canvas;
    }
    const ratio = Math.min(maxDim / w, maxDim / h);
    const newW = Math.floor(w * ratio);
    const newH = Math.floor(h * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = newW;
    canvas.height = newH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, newW, newH);
    return canvas;
  }

  /** Get pixel data as Uint8ClampedArray from canvas */
  function getPixelData(canvas) {
    const ctx = canvas.getContext('2d');
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  /** Euclidean distance in RGB */
  function colorDist(c1, c2) {
    const dr = c1[0] - c2[0];
    const dg = c1[1] - c2[1];
    const db = c1[2] - c2[2];
    return dr * dr + dg * dg + db * db;
  }

  /** Median cut to exactly 3 colors, returns palette and quantized canvas (willReadFrequently on output canvas too) */
  function quantizeTo3Colors(imgCanvas) {
    const w = imgCanvas.width;
    const h = imgCanvas.height;
    const data = getPixelData(imgCanvas);
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      pixels.push([r, g, b]);
    }

    // Box-based median cut for exactly 3 colors
    function medianCut3(pixels) {
      class Box {
        constructor(pixels) {
          this.pixels = pixels;
          this.min = [255,255,255];
          this.max = [0,0,0];
          for (const p of pixels) {
            for (let c=0;c<3;c++) {
              if (p[c] < this.min[c]) this.min[c] = p[c];
              if (p[c] > this.max[c]) this.max[c] = p[c];
            }
          }
        }
        get longestSide() {
          return Math.max(this.max[0]-this.min[0], this.max[1]-this.min[1], this.max[2]-this.min[2]);
        }
        split() {
          let channel = 0;
          let maxRange = this.max[0]-this.min[0];
          if ((this.max[1]-this.min[1]) > maxRange) { channel=1; maxRange=this.max[1]-this.min[1]; }
          if ((this.max[2]-this.min[2]) > maxRange) { channel=2; }
          this.pixels.sort((a,b) => a[channel]-b[channel]);
          const mid = Math.floor(this.pixels.length/2);
          return [new Box(this.pixels.slice(0,mid)), new Box(this.pixels.slice(mid))];
        }
        averageColor() {
          if (this.pixels.length===0) return [0,0,0];
          let r=0,g=0,b=0;
          for (const p of this.pixels) { r+=p[0]; g+=p[1]; b+=p[2]; }
          return [Math.round(r/this.pixels.length), Math.round(g/this.pixels.length), Math.round(b/this.pixels.length)];
        }
      }
      let boxes = [new Box(pixels)];
      while (boxes.length < 3) {
        let maxLen = -1, idx = -1;
        for (let i=0; i<boxes.length; i++) {
          const len = boxes[i].longestSide;
          if (len > maxLen) { maxLen = len; idx = i; }
        }
        if (idx===-1) break;
        const toSplit = boxes.splice(idx,1)[0];
        const newBoxes = toSplit.split();
        boxes.push(newBoxes[0], newBoxes[1]);
      }
      return boxes.map(box => box.averageColor());
    }

    const finalPalette = medianCut3(pixels);

    // Remap each pixel to closest palette color
    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
    const outImageData = outCtx.createImageData(w, h);
    const outData = outImageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let j = 0; j < finalPalette.length; j++) {
        const d = colorDist([r,g,b], finalPalette[j]);
        if (d < bestDist) { bestDist = d; bestIdx = j; }
      }
      outData[i]   = finalPalette[bestIdx][0];
      outData[i+1] = finalPalette[bestIdx][1];
      outData[i+2] = finalPalette[bestIdx][2];
      outData[i+3] = 255;
    }
    outCtx.putImageData(outImageData, 0, 0);
    return { palette: finalPalette, quantizedCanvas: outCanvas };
  }

  /** Build base grid from quantized image and selected wall colors */
  function buildBaseGrid(quantizedCanvas, palette, wallIndices) {
    const w = quantizedCanvas.width;
    const h = quantizedCanvas.height;
    const data = getPixelData(quantizedCanvas);
    const grid = new Array(h);
    for (let y = 0; y < h; y++) grid[y] = new Array(w).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      let idx = palette.findIndex(p => p[0]===r && p[1]===g && p[2]===b);
      if (idx === -1) {
        // fallback to closest (should not happen)
        let minDist = Infinity;
        palette.forEach((p, pi) => {
          const d = colorDist([r,g,b], p);
          if (d < minDist) { minDist = d; idx = pi; }
        });
      }
      const pixelIndex = i / 4;
      const x = pixelIndex % w;
      const y = Math.floor(pixelIndex / w);
      if (wallIndices.has(idx)) grid[y][x] = 1;
    }
    return grid;
  }

  /** Merge Image B walls (alpha > 0) into existing grid */
  function mergeImageBWalls(baseGrid, imgBCanvas) {
    const w = imgBCanvas.width;
    const h = imgBCanvas.height;
    if (w !== gridWidth || h !== gridHeight) throw new Error('Image B dimensions mismatch');
    const data = getPixelData(imgBCanvas);
    const newGrid = baseGrid.map(row => [...row]);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i+3] > 0) {
        const pixelIndex = i / 4;
        const x = pixelIndex % w;
        const y = Math.floor(pixelIndex / w);
        newGrid[y][x] = 1;
      }
    }
    return newGrid;
  }

  /** Find brightest pixel in Image C (R+G+B) */
  function findBrightestPixel(imgCCanvas) {
    const w = imgCCanvas.width;
    const h = imgCCanvas.height;
    const data = getPixelData(imgCCanvas);
    let maxBright = -1, bestX = 0, bestY = 0;
    for (let i = 0; i < data.length; i += 4) {
      const bright = data[i] + data[i+1] + data[i+2];
      if (bright > maxBright) {
        maxBright = bright;
        bestX = (i/4) % w;
        bestY = Math.floor((i/4) / w);
      }
    }
    return { x: bestX, y: bestY };
  }

  /* ─────────────── Swatches UI ─────────────── */
  function updateSwatches(palette) {
    swatchesContainer.innerHTML = '<span class="swatches-label">Walls:</span>';
    palette.forEach((color, idx) => {
      const hex = `rgb(${color[0]},${color[1]},${color[2]})`;
      const swatchDiv = document.createElement('div');
      swatchDiv.className = 'swatch-item';
      if (selectedWallColors.has(idx)) swatchDiv.classList.add('selected-wall');
      swatchDiv.innerHTML = `
        <div class="swatch-color" style="background:${hex};"></div>
        <input type="checkbox" id="swatch-${idx}" ${selectedWallColors.has(idx) ? 'checked' : ''}>
        <label class="swatch-label-text" for="swatch-${idx}">Wall</label>
      `;
      const checkbox = swatchDiv.querySelector('input');
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) selectedWallColors.add(idx);
        else selectedWallColors.delete(idx);
        swatchDiv.classList.toggle('selected-wall', e.target.checked);
        recomputeAll();
      });
      swatchesContainer.appendChild(swatchDiv);
    });
  }

  /* ─────────────── Pathfinding ─────────────── */
  function findPath() {
    return new Promise((resolve, reject) => {
      if (typeof EasyStar === 'undefined') return reject(new Error('EasyStar not loaded'));
      if (!mergedGrid || !targetPoint) return reject(new Error('Missing grid or target'));
      if (START_POINT.x < 0 || START_POINT.x >= gridWidth || START_POINT.y < 0 || START_POINT.y >= gridHeight)
        return reject(new Error('Start point out of bounds'));
      if (mergedGrid[START_POINT.y][START_POINT.x] === 1) return reject(new Error('Start point is a wall'));
      if (mergedGrid[targetPoint.y][targetPoint.x] === 1) return reject(new Error('Target point is a wall'));

      const easystar = new EasyStar.js();
      easystar.setGrid(mergedGrid);
      easystar.setAcceptableTiles([0]);
      easystar.enableDiagonals(false);
      easystar.enableCornerCutting(false);
      easystar.setIterationsPerCalculation(1000);

      easystar.findPath(START_POINT.x, START_POINT.y, targetPoint.x, targetPoint.y, (path) => {
        if (path === null) reject(new Error('No path found'));
        else resolve(path);
      });
      easystar.calculate();
    });
  }

  /* ─────────────── Main Recompute ─────────────── */
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
        const newSelected = new Set();
        for (let i = 0; i < palette.length; i++) if (selectedWallColors.has(i)) newSelected.add(i);
        selectedWallColors = newSelected;
        updateSwatches(palette);
      }
      const quantizedCanvas = window._cachedQuantizedA;
      gridWidth = quantizedCanvas.width;
      gridHeight = quantizedCanvas.height;

      baseGrid = buildBaseGrid(quantizedCanvas, palette, selectedWallColors);
      mergedGrid = baseGrid.map(row => [...row]);

      if (imageBData) {
        const resizedB = resizeImage(imageBData, MAX_DIM);
        if (resizedB.width !== gridWidth || resizedB.height !== gridHeight)
          throw new Error('Image B dimensions do not match Image A after resizing');
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
    baseGrid = null;
    mergedGrid = null;
    targetPoint = null;
    currentPath = [];
    palette = [];
    selectedWallColors.clear();
    window._cachedQuantizedA = null;
    updateSwatches([]);
    gridWidth = 0;
    gridHeight = 0;
  }

  /* ─────────────── Status Updates ─────────────── */
  function updateStatus(which, text, dotClass) {
    const statusEl = which === 'A' ? statusA : which === 'B' ? statusB : which === 'C' ? statusC : statusPath;
    const dotEl = which === 'A' ? dotA : which === 'B' ? dotB : which === 'C' ? dotC : dotPath;
    statusEl.textContent = text;
    dotEl.className = 'status-dot ' + (dotClass || 'neutral');
  }

  /* ─────────────── Rendering ─────────────── */
  function fitGridToView() {
    if (gridWidth === 0 || gridHeight === 0) return;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    const scaleX = containerW / gridWidth;
    const scaleY = containerH / gridHeight;
    scale = Math.min(scaleX, scaleY, 4);
    offsetX = (containerW - gridWidth * scale) / 2;
    offsetY = (containerH - gridHeight * scale) / 2;
  }

  function render() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    if (!mergedGrid || gridWidth === 0 || gridHeight === 0) {
      ctx.fillStyle = '#0d0d1a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#555';
      ctx.font = '14px sans-serif';
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

    ctx.fillStyle = '#00cc66';
    ctx.fillRect(START_POINT.x, START_POINT.y, 1, 1);
    if (targetPoint) {
      ctx.fillStyle = '#4488ff';
      ctx.fillRect(targetPoint.x, targetPoint.y, 1, 1);
    }
    if (currentPath.length > 0) {
      ctx.fillStyle = '#ffcc00';
      for (const p of currentPath) ctx.fillRect(p.x, p.y, 1, 1);
    }

    if (scale >= 8) {
      ctx.strokeStyle = 'rgba(0,0,0,0.1)';
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      for (let x = 0; x <= gridWidth; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, gridHeight); }
      for (let y = 0; y <= gridHeight; y++) { ctx.moveTo(0, y); ctx.lineTo(gridWidth, y); }
      ctx.stroke();
    }

    ctx.restore();
    zoomIndicator.textContent = Math.round(scale * 100) + '%';
  }

  /* ─────────────── Pan & Zoom ─────────────── */
  function getEventPos(e) { return { x: e.clientX, y: e.clientY }; }

  container.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      isPanning = true;
      panStart = getEventPos(e);
      container.classList.add('grabbing');
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const pos = getEventPos(e);
    offsetX += pos.x - panStart.x;
    offsetY += pos.y - panStart.y;
    panStart = pos;
    render();
    e.preventDefault();
  });

  window.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      container.classList.remove('grabbing');
    }
  });

  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - offsetX) / scale;
    const worldY = (mouseY - offsetY) / scale;
    const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    scale = Math.min(Math.max(scale * zoomFactor, 0.2), 30);
    offsetX = mouseX - worldX * scale;
    offsetY = mouseY - worldY * scale;
    render();
  });

  window.addEventListener('resize', render);

  /* ─────────────── File Input Handlers ─────────────── */
  fileA.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const img = await loadImage(file);
      imageAData = img;
      imageAData._dirty = true;
      selectedWallColors.clear();
      updateStatus('A', 'loaded', 'good');
      await recomputeAll();
    } catch (err) {
      updateStatus('A', 'error loading', 'error');
    }
  });

  fileB.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) {
      imageBData = null;
      updateStatus('B', 'not loaded', 'neutral');
      await recomputeAll();
      return;
    }
    try {
      imageBData = await loadImage(file);
      updateStatus('B', 'loaded', 'good');
      await recomputeAll();
    } catch (err) {
      updateStatus('B', 'error loading', 'error');
    }
  });

  fileC.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) {
      imageCData = null;
      updateStatus('C', 'not loaded', 'neutral');
      await recomputeAll();
      return;
    }
    try {
      imageCData = await loadImage(file);
      updateStatus('C', 'loaded', 'good');
      await recomputeAll();
    } catch (err) {
      updateStatus('C', 'error loading', 'error');
    }
  });

  /* ─────────────── Initial ─────────────── */
  resetGrid();
  render();
  updateStatus('A', 'not loaded', 'neutral');
  updateStatus('B', 'not loaded', 'neutral');
  updateStatus('C', 'not loaded', 'neutral');
  updateStatus('path', 'ready', 'neutral');
})();
