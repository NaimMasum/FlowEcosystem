const express = require('express');
const path = require('path');

const app = express();
const PORT = 4040;

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to official PDF.js viewer
app.get('/', (req, res) => {
  res.redirect('/web/viewer.html');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log('Flow PDF Annotator started!');
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log('==================================================');
});
