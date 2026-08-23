'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'design', 'icon-concepts', 'v001', 'option-a-folding-plane.png');
const buildDir = path.join(root, 'build');
const rendererAssetDir = path.join(root, 'src', 'renderer', 'assets');
const pngPath = path.join(buildDir, 'icon.png');
const icoPath = path.join(buildDir, 'icon.ico');
const rendererPath = path.join(rendererAssetDir, 'app-icon.png');
const sizes = [256, 128, 64, 48, 32, 16];

function resizeBilinear(source, size) {
  const output = new PNG({ width: size, height: size });
  const scaleX = source.width / size;
  const scaleY = source.height / size;

  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.max(0, Math.min(source.height - 1, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sourceY - y0;

    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.max(0, Math.min(source.width - 1, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const outputOffset = (y * size + x) * 4;

      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = source.data[(y0 * source.width + x0) * 4 + channel];
        const topRight = source.data[(y0 * source.width + x1) * 4 + channel];
        const bottomLeft = source.data[(y1 * source.width + x0) * 4 + channel];
        const bottomRight = source.data[(y1 * source.width + x1) * 4 + channel];
        const top = topLeft + (topRight - topLeft) * fx;
        const bottom = bottomLeft + (bottomRight - bottomLeft) * fx;
        output.data[outputOffset + channel] = Math.round(top + (bottom - top) * fy);
      }
    }
  }

  return PNG.sync.write(output);
}

function makeIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + images.length * entrySize;
  const totalSize = directorySize + images.reduce((sum, image) => sum + image.data.length, 0);
  const ico = Buffer.alloc(totalSize);

  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(images.length, 4);

  let dataOffset = directorySize;
  images.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize;
    ico.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset);
    ico.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset + 1);
    ico.writeUInt8(0, entryOffset + 2);
    ico.writeUInt8(0, entryOffset + 3);
    ico.writeUInt16LE(1, entryOffset + 4);
    ico.writeUInt16LE(32, entryOffset + 6);
    ico.writeUInt32LE(image.data.length, entryOffset + 8);
    ico.writeUInt32LE(dataOffset, entryOffset + 12);
    image.data.copy(ico, dataOffset);
    dataOffset += image.data.length;
  });

  return ico;
}

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Selected icon source is missing: ${sourcePath}`);
}

const sourceBuffer = fs.readFileSync(sourcePath);
const source = PNG.sync.read(sourceBuffer);
if (source.width !== source.height) {
  throw new Error(`Icon source must be square; got ${source.width}x${source.height}`);
}

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(rendererAssetDir, { recursive: true });
fs.copyFileSync(sourcePath, pngPath);
fs.copyFileSync(sourcePath, rendererPath);

const images = sizes.map((size) => ({ size, data: resizeBilinear(source, size) }));
fs.writeFileSync(icoPath, makeIco(images));

console.log(`Built ${icoPath} with ${sizes.join(', ')}px layers.`);
