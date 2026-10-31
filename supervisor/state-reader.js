// supervisor/state-reader.js
const fs = require('fs');
const path = require('path');

/**
 * 读取一本书的当前状态
 * @param {string} bookDir - 书的根目录绝对路径
 * @returns {object} 状态对象
 */
function readBookState(bookDir) {
  const state = {
    book_id: path.basename(bookDir),
    has_outline: false,
    has_characters: false,
    has_volume_outline: false,
    has_chapter_outlines: false,
    chapters: [],
  };

  // 检查 steps/ 下的关键文件
  const stepsDir = path.join(bookDir, 'steps');
  if (fs.existsSync(stepsDir)) {
    const files = fs.readdirSync(stepsDir);
    state.has_outline = files.some(f => f.includes('大纲') && f.endsWith('.md'));
    state.has_characters = files.some(f => f.includes('人物') && f.endsWith('.md'));
    state.has_volume_outline = files.some(f => f.includes('卷大纲') && f.endsWith('.md'));
  }

  // 检查章节大纲
  const outlineDir = path.join(bookDir, 'chapter-outlines');
  state.has_chapter_outlines = fs.existsSync(outlineDir) &&
    fs.readdirSync(outlineDir).some(f => f.endsWith('.md'));

  // 检查 chapters/ 下每一章的草稿和润色稿
  const chaptersDir = path.join(bookDir, 'chapters');
  if (fs.existsSync(chaptersDir)) {
    const chapterFiles = fs.readdirSync(chaptersDir).filter(f => f.endsWith('.md'));
    const chapterMap = {};
    for (const f of chapterFiles) {
      const match = f.match(/第(\d+)章/);
      if (!match) continue;
      const num = parseInt(match[1], 10);
      if (!chapterMap[num]) chapterMap[num] = { index: num, has_draft: false, has_polished: false };
      if (f.includes('润色')) chapterMap[num].has_polished = true;
      else chapterMap[num].has_draft = true;
    }
    state.chapters = Object.values(chapterMap).sort((a, b) => a.index - b.index);
  }

  return state;
}

module.exports = { readBookState };