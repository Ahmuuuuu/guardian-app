#!/usr/bin/env node
/**
 * 编码修复脚本
 * 用途：将 data 文件夹中的 JSON 文件转换为正确的 UTF-8 编码
 * 使用方法：cd client && node fix-encoding.js
 */

const fs = require('fs');
const path = require('path');
const iconvLite = require('iconv-lite');

const DATA_DIR = path.join(__dirname, 'data');

// 需要转换的文件列表
const FILES_TO_FIX = [
  'config.json',
  'whitelist.json',
  'remote-config.json'
];

console.log('╔════════════════════════════════════════════╗');
console.log('║   Guardian Client 编码修复工具              ║');
console.log('╚════════════════════════════════════════════╝\n');

if (!fs.existsSync(DATA_DIR)) {
  console.log('✅ data 文件夹不存在，使用默认配置即可\n');
  process.exit(0);
}

FILES_TO_FIX.forEach(filename => {
  const filePath = path.join(DATA_DIR, filename);

  if (!fs.existsSync(filePath)) {
    console.log(`⏭️  跳过 ${filename} (不存在)\n`);
    return;
  }

  try {
    // 读取文件的原始字节
    const buffer = fs.readFileSync(filePath);

    // 检测当前编码
    let content;
    let detectedEncoding = 'unknown';

    // 尝试多种编码解码
    const encodings = [
      { name: 'utf8', encoding: 'utf8' },
      { name: 'utf16le', encoding: 'utf16le' },
      { name: 'utf16be', encoding: 'utf16be' },
      { name: 'cp936 (GBK)', encoding: 'cp936' },
      { name: 'binary', encoding: 'binary' }
    ];

    for (const enc of encodings) {
      try {
        const decoded = buffer.toString(enc.encoding);
        const parsed = JSON.parse(decoded);
        detectedEncoding = enc.name;
        content = JSON.stringify(parsed, null, 2);
        break;
      } catch (e) {
        // 继续尝试下一个编码
      }
    }

    if (detectedEncoding === 'unknown') {
      console.log(`⚠️  ${filename}: 无法识别编码，跳过\n`);
      return;
    }

    // 以 UTF-8 写回
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ ${filename}: 已从 ${detectedEncoding} 转换为 UTF-8\n`);

  } catch (err) {
    console.log(`❌ ${filename}: 转换失败 - ${err.message}\n`);
  }
});

console.log('╔════════════════════════════════════════════╗');
console.log('║   编码修复完成！                             ║');
console.log('║   现在可以运行 npm start 了                  ║');
console.log('╚════════════════════════════════════════════╝');
