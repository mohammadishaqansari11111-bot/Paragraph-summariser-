const $ = (id) => document.getElementById(id);
const source = $('source');
let selectedLength = 'medium';
let busy = false;
let toastTimer;
const wordCount = (text) => text.trim() ? text.trim().split(/\s+/u).length : 0;
const sampleText = `Urban green spaces play an important role in making cities healthier and more livable. Parks, community gardens, and tree-lined streets help lower temperatures by providing shade and releasing moisture into the air. They also improve air quality by absorbing pollutants and provide habitats for birds and other wildlife. Research suggests that spending time in nature can reduce stress, improve mood, and help people concentrate. Green spaces encourage physical activity and give neighbors places to meet, strengthening community connections. However, access to these benefits is not equal. Lower-income neighborhoods often have fewer parks and less tree cover than wealthier areas. City planners can address this gap by investing in accessible green spaces, involving local residents in planning, and maintaining existing parks. Creating a greener city is not simply about planting more trees; it requires thoughtful planning to make sure everyone can enjoy the environmental, physical, and social benefits.`;
function updateCount() {
  $('source-count').replaceChildren(document.createTextNode(`${wordCount(source.value).toLocaleString()} words · ${source.value.length.toLocaleString()} characters`));
  $('sample-prompt').hidden = source.value.length > 0;
}
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
function resetOutput() {
  $('summary').textContent = '';
  $('summary').hidden = true;
  $('empty-state').hidden = false;
  $('result-badge').hidden = true;
  $('summary-count').textContent = '0 words';
  $('reduction').textContent = 'Made for easier reading';
  $('copy').disabled = $('download').disabled = true;
}
function setBusy(value, action = 'summary') {
  busy = value;
  $('summarize').disabled = value;
  $('summarize').querySelector('span').textContent = value ? (action === 'upload' ? 'Reading file…' : 'Summarizing…') : 'Summarize text';
  $('output-area').setAttribute('aria-busy', String(value));
  source.disabled = value;
  ['clear','sample','upload','file-input','format'].forEach(id => $(id).disabled = value);
  document.querySelectorAll('#lengths button').forEach(button => button.disabled = value);
}
source.addEventListener('input', () => { updateCount(); showError(''); $('upload-status').textContent = ''; });
$('sample').addEventListener('click', () => { source.value = sampleText; $('upload-status').textContent = ''; updateCount(); source.focus(); });
$('clear').addEventListener('click', () => { source.value = ''; $('upload-status').textContent = ''; updateCount(); resetOutput(); showError(''); source.focus(); });
document.querySelectorAll('#lengths button').forEach(button => button.addEventListener('click', () => {
  selectedLength = button.dataset.value;
  document.querySelectorAll('#lengths button').forEach(item => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
}));
$('upload').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || busy) return;
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['txt','pdf','png','jpg','jpeg','webp','mp3','wav','m4a','aac','flac','ogg'].includes(extension)) {
    showError('Choose a supported document, image, or audio file.'); return;
  }
  if (!file.size || file.size > 10 * 1024 * 1024) { showError('Choose a non-empty file smaller than 10 MB.'); return; }
  showError(''); setBusy(true, 'upload');
  $('upload-status').textContent = `Reading ${file.name}…`;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 150000);
  try {
    let text;
    if (extension === 'txt') {
      // Plain text stays in the browser; other formats need server extraction.
      if (file.size > 200000) throw new Error('This text exceeds 50,000 characters. Please choose a shorter file.');
      text = await file.text();
    } else {
      const form = new FormData(); form.append('file', file);
      const response = await fetch('/api/extract', { method: 'POST', body: form, signal: abort.signal });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'The upload failed. Please try again.');
      }
      if (!response.body) throw new Error('No text was received. Please try again.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', complete = false;
      function consume(line) {
        if (!line.trim()) return;
        const data = JSON.parse(line);
        if (data.type === 'error') throw new Error(data.error);
        if (data.type === 'extracted') text = data.text;
        if (data.type === 'done') complete = true;
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(consume);
        }
        buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
        if (!complete) throw new Error('Extraction was interrupted. Try a shorter or clearer file.');
      } finally { await reader.cancel().catch(() => {}); }
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('No readable text or speech was found in this file.');
    if (text.length > 50000) throw new Error('Extracted text exceeds 50,000 characters. Please choose a shorter file.');
    source.value = text; updateCount(); resetOutput();
    $('upload-status').textContent = `${file.name} is ready. Review the text, then select Summarize text.`;
  } catch (error) {
    $('upload-status').textContent = '';
    showError(error.name === 'AbortError' ? 'Reading this file took too long. Try a shorter recording or document.' : error.message);
  } finally { clearTimeout(timeout); setBusy(false); }
});
$('summarize').addEventListener('click', async () => {
  if (busy) return;
  if (source.value.trim().length < 40) { showError('Add a little more text — at least 40 characters — so we can find the key ideas.'); source.focus(); return; }
  const originalWords = wordCount(source.value);
  showError(''); resetOutput(); setBusy(true);
  $('empty-state').hidden = true;
  $('skeleton').hidden = false;
  let complete = false;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 90000);
  try {
    const response = await fetch('/api/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: source.value, length: selectedLength, format: $('format').value }), signal: abort.signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'We couldn’t connect. Please try again in a moment.');
    }
    if (!response.body) throw new Error('No summary was received. Please try again.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    function consume(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.error);
      if (event.type === 'done') complete = true;
      if (event.type === 'text') {
        $('skeleton').hidden = true; $('summary').hidden = false;
        $('summary').textContent += event.text;
        $('summary-count').textContent = `${wordCount($('summary').textContent)} words`;
      }
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      lines.forEach(consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!complete || !$('summary').textContent.trim()) throw new Error('The summary was interrupted. Please try again.');
    const reduction = Math.round((1 - wordCount($('summary').textContent) / originalWords) * 100);
    $('reduction').textContent = reduction > 0 ? `${reduction}% less to read` : 'Your key ideas, made clear';
    $('result-badge').hidden = false;
    $('copy').disabled = $('download').disabled = false;
  } catch (error) {
    resetOutput();
    showError(error.name === 'AbortError' ? 'This is taking a little too long. Please try again with a shorter passage.' : error.message);
  } finally { clearTimeout(timeout); $('skeleton').hidden = true; setBusy(false); }
});
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('summary').textContent);
    $('toast').textContent = 'Summary copied to clipboard'; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 2500);
  } catch { showError('Copy is unavailable in this browser. You can select the summary text or download it instead.'); }
});
$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([$('summary').textContent], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'briefly-summary.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
source.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('summarize').click(); } });
