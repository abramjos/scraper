const fs = require('fs');

try {
  const content = fs.readFileSync('background.js', 'utf8');
  // Just a simple eval to parse for syntax errors
  new Function(content);
  console.log('background.js syntax OK');
} catch (e) {
  console.error('Syntax error in background.js:', e);
}

try {
  const content2 = fs.readFileSync('popup.js', 'utf8');
  new Function(content2);
  console.log('popup.js syntax OK');
} catch (e) {
  console.error('Syntax error in popup.js:', e);
}
