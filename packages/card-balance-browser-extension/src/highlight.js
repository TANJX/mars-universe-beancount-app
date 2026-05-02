// Highlight balance numbers on page with support for dynamically loaded content
export function highlightBalanceOnPage(balanceValue) {
  // Clear previous highlights
  clearHighlights();

  // Wait a bit for dynamic content to load, then try highlighting multiple times
  setTimeout(() => performHighlight(balanceValue), 100);
  setTimeout(() => performHighlight(balanceValue), 500);
  setTimeout(() => performHighlight(balanceValue), 1000);

  // Set up mutation observer to catch content loaded after initial attempts
  setupMutationObserver(balanceValue);
}

function clearHighlights() {
  document.querySelectorAll('.balance-highlight').forEach(el => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    }
  });
}

function performHighlight(balanceValue) {
  // Format balance to search patterns
  const absBalance = Math.abs(balanceValue);
  const formattedBalance = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(absBalance);

  // Create search patterns (with and without dollar sign, with and without commas)
  const patterns = [
    formattedBalance, // $1,234.56
    formattedBalance.replace(/\$/g, ''), // 1,234.56
    absBalance.toFixed(2), // 1234.56
    absBalance.toString(), // 1234.56 or 1234
    // Also try with parentheses for negative numbers
    `(${formattedBalance.replace(/\$/g, '')})`,
    `($${formattedBalance.replace(/\$/g, '')})`
  ];

  // Walk through all text nodes
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        // Skip script, style, and our extension elements
        if (!node.parentElement || node.parentElement.closest('script, style, .credit-balance-dialog, .balance-highlight')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodesToHighlight = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    for (const pattern of patterns) {
      if (node.textContent.includes(pattern)) {
        nodesToHighlight.push({ node, pattern });
        break;
      }
    }
  }

  // Highlight found text
  nodesToHighlight.forEach(({ node, pattern }) => {
    // Skip if already highlighted
    if (node.parentElement && node.parentElement.classList.contains('balance-highlight')) {
      return;
    }

    const text = node.textContent;
    const index = text.indexOf(pattern);
    if (index !== -1) {
      const before = text.substring(0, index);
      const match = text.substring(index, index + pattern.length);
      const after = text.substring(index + pattern.length);

      const span = document.createElement('span');
      span.className = 'balance-highlight';
      span.textContent = match;

      const parent = node.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(after), node);
        parent.insertBefore(span, parent.firstChild.nextSibling);
        parent.insertBefore(document.createTextNode(before), parent.firstChild);
      }
    }
  });
}

let currentObserver = null;

function setupMutationObserver(balanceValue) {
  // Disconnect previous observer if exists
  if (currentObserver) {
    currentObserver.disconnect();
  }

  // Create new observer to watch for DOM changes
  currentObserver = new MutationObserver(() => {
    // Debounce the highlighting
    clearTimeout(currentObserver.timer);
    currentObserver.timer = setTimeout(() => {
      performHighlight(balanceValue);
    }, 200);
  });

  // Start observing
  currentObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Stop observing after 10 seconds to avoid performance issues
  setTimeout(() => {
    if (currentObserver) {
      currentObserver.disconnect();
    }
  }, 10000);
}
