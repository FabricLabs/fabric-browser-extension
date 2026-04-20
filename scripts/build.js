const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { execSync } = require('child_process');

// Configuration
const BUILD_DIR = path.resolve(__dirname, '../dist');
const ZIP_DIR = path.resolve(__dirname, '../zip');
const MANIFEST_SRC = path.resolve(__dirname, '../src/manifest.json');
const MANIFEST_DEST = path.resolve(BUILD_DIR, 'manifest.json');

// Ensure directories exist
if (!fs.existsSync(BUILD_DIR)) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
}
if (!fs.existsSync(ZIP_DIR)) {
  fs.mkdirSync(ZIP_DIR, { recursive: true });
}

// Clean up previous build
if (fs.existsSync(BUILD_DIR)) {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR);
}

console.log('🚀 Starting production build...');

try {
  // Run production build
  execSync('npm run build', { stdio: 'inherit' });
  console.log('✅ Production build completed successfully');

  // Copy manifest file
  fs.copyFileSync(MANIFEST_SRC, MANIFEST_DEST);
  console.log('✅ Manifest file copied');

  // Create zip file
  const version = require(MANIFEST_SRC).version;
  const zipPath = path.join(ZIP_DIR, `fabric-extension-v${version}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', {
    zlib: { level: 9 }
  });

  output.on('close', () => {
    const size = (archive.pointer() / 1024 / 1024).toFixed(2);
    console.log(`✅ Extension packaged successfully (${size} MB)`);
    console.log(`📦 Package location: ${zipPath}`);
  });

  archive.on('error', (err) => {
    throw err;
  });

  archive.pipe(output);
  archive.directory(BUILD_DIR, false);
  archive.finalize();

} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
} 