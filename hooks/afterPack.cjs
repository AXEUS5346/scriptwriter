const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const outDir = context.appOutDir;
  const resources = path.join(outDir, 'resources');
  const src = path.resolve(__dirname, '..', 'dist');

  // electron-builder's copy engine drops node_modules/ inside extraResources
  // (its filter treats it as dev-only). Re-copy the full Next standalone app
  // over the staged copy so shipped server(s) have complete dependencies.
  fs.cpSync(path.join(src, 'app'), path.join(resources, 'app'), {
    recursive: true,
    force: true,
  });
  if (!fs.existsSync(path.join(resources, 'models'))) {
    fs.cpSync(path.join(src, 'models'), path.join(resources, 'models'), {
      recursive: true,
    });
  }
  if (!fs.existsSync(path.join(resources, 'node'))) {
    fs.cpSync(path.join(src, 'node'), path.join(resources, 'node'), {
      recursive: true,
    });
  }
  console.log('afterPack: node_modules files in resources/app:',
    countFiles(path.join(resources, 'app', 'node_modules')));
};

function countFiles(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
      else n += 1;
    }
  } catch {}
  return n;
}
