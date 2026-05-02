
export function findTextInPage(searchText) {
    // Convert search text to lowercase for case-insensitive search
    const searchLower = searchText.toLowerCase();

    // Get all text content from the page
    const pageText = document.body.textContent || document.body.innerText;
    const pageLower = pageText.toLowerCase();

    // Return true if text is found, false otherwise
    return pageLower.includes(searchLower);
}

export function displayDialog(output) {
    // Create dialog elements
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      z-index: 1001;
      max-width: 80%;
      max-height: 80vh;
      overflow-y: auto;
      text-align: left;
      color: black;
    `;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
    `;

    // Create close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
      position: absolute;
      right: 10px;
      top: 10px;
      border: none;
      background: none;
      font-size: 20px;
      cursor: pointer;
    `;

    // Create content area
    const content = document.createElement('pre');
    content.style.cssText = `
      white-space: pre-wrap;
      word-break: break-word;
    `;
    content.textContent = output.join('\n');

    // Add close functionality
    const closeDialog = () => {
        document.body.removeChild(dialog);
        document.body.removeChild(overlay);
    };
    closeBtn.onclick = closeDialog;
    overlay.onclick = closeDialog;

    // Assemble and show dialog
    dialog.appendChild(closeBtn);
    dialog.appendChild(content);
    document.body.appendChild(overlay);
    document.body.appendChild(dialog);

    // Scroll dialog to bottom
    dialog.scrollTop = dialog.scrollHeight;

}