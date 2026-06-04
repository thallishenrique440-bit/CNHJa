import sharp from 'sharp';
import * as fs from 'fs';

async function analyzeImage(filePath: string) {
  console.log(`\n=== Analyzing: ${filePath} ===`);
  if (!fs.existsSync(filePath)) {
    console.log(`File does not exist: ${filePath}`);
    return;
  }

  const image = sharp(filePath);
  const metadata = await image.metadata();
  console.log(`Metadata format: ${metadata.format}`);
  console.log(`Dimensions: ${metadata.width}x${metadata.height}`);
  console.log(`Has Alpha channel: ${metadata.hasAlpha}`);

  // Get raw pixels to calculate bounding box of non-transparent (opaque/semi-opaque) pixels
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  
  if (!metadata.hasAlpha || info.channels < 4) {
    console.log('No alpha channel or less than 4 channels. It is fully opaque.');
    return;
  }

  // Find min/max coordinates of non-transparent pixels (Alpha > 10)
  let minX = info.width;
  let maxX = -1;
  let minY = info.height;
  let maxY = -1;
  let opaquePixelsCount = 0;

  const totalPixels = info.width * info.height;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels;
      const alpha = data[idx + 3]; // Alpha is the 4th channel
      
      if (alpha > 10) { // arbitrary threshold for non-fully transparent
        opaquePixelsCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (opaquePixelsCount === 0) {
    console.log('The image is completely transparent!');
    return;
  }

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const areaOccupiedPercentage = ((contentWidth * contentHeight) / (info.width * info.height) * 100).toFixed(2);
  const opaquePercentage = (opaquePixelsCount / totalPixels * 100).toFixed(2);

  console.log(`Content bounding box (non-transparent pixels):`);
  console.log(`  - Left Padding (X start): ${minX} px`);
  console.log(`  - Right Padding (X end boundary): ${info.width - 1 - maxX} px`);
  console.log(`  - Top Padding (Y start): ${minY} px`);
  console.log(`  - Bottom Padding (Y end boundary): ${info.height - 1 - maxY} px`);
  console.log(`  - Content dimensions: ${contentWidth}x${contentHeight} px`);
  console.log(`  - Content bounding box area covers ${areaOccupiedPercentage}% of the total image canvas.`);
  console.log(`  - Total actual opaque pixels cover ${opaquePercentage}% of the image.`);
}

async function start() {
  await analyzeImage('./public/android-chrome-192x192.png');
  await analyzeImage('./public/android-chrome-512x512.png');
}

start().catch(console.error);
