const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

// Copy sidebar assets and UIA worker to dist
function copyAssets() {
    const srcDir = path.join(__dirname, 'src', 'sidebar');
    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
    for (const file of ['webview.css', 'webview.js']) {
        const src = path.join(srcDir, file);
        const dest = path.join(distDir, file);
        if (fs.existsSync(src)) fs.copyFileSync(src, dest);
    }
    // Copy UIA worker script
    const uiaSrc = path.join(__dirname, 'src', 'uia-worker.ps1');
    const uiaDest = path.join(distDir, 'uia-worker.ps1');
    if (fs.existsSync(uiaSrc)) fs.copyFileSync(uiaSrc, uiaDest);
}

const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    minify: !isWatch,
};

async function main() {
    copyAssets();
    if (isWatch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('Watching for changes...');
    } else {
        await esbuild.build(buildOptions);
        console.log('Build complete.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
