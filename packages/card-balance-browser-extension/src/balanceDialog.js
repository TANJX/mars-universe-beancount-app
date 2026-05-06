import { makeDraggable } from './draggable.js';
import { highlightBalanceOnPage } from './highlight.js';
import { findTextInPage } from './utils.js';
import { extractAmexChecking } from './extractors/amex.js';
import { extractFuture } from './extractors/future.js';
import { extractRobinhood } from './extractors/robinhood.js';

const API_BASE_URL = 'http://127.0.0.1:5000';
// Fava slugifies the journal title for the URL prefix. Set FAVA_LEDGER_SLUG at
// build time (see build.js); falls back to the public demo ledger's slug.
const FAVA_LEDGER_SLUG = process.env.FAVA_LEDGER_SLUG || 'acme-demo';

export function createBalanceDialog(account) {
  const dialog = document.createElement('div');
  dialog.className = 'credit-balance-dialog';

  const header = document.createElement('div');
  header.className = 'credit-balance-header';

  const title = document.createElement('h3');
  title.textContent = 'Account Balances';

  const controls = document.createElement('div');
  controls.className = 'credit-balance-controls';

  const refreshButton = document.createElement('button');
  refreshButton.className = 'credit-balance-refresh';
  refreshButton.innerHTML = '↻';
  refreshButton.title = 'Refresh balances';
  refreshButton.onclick = () => loadBalances(dialog, account, refreshButton);

  const closeButton = document.createElement('button');
  closeButton.className = 'credit-balance-close';
  closeButton.innerHTML = '×';
  closeButton.onclick = () => dialog.remove();

  controls.appendChild(refreshButton);
  controls.appendChild(closeButton);

  header.appendChild(title);
  header.appendChild(controls);
  dialog.appendChild(header);

  // Container for balance items
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'credit-balance-items';
  dialog.appendChild(itemsContainer);

  // Make dialog draggable
  makeDraggable(dialog);

  // Add to DOM
  document.body.appendChild(dialog);

  // Load balances
  loadBalances(dialog, account, refreshButton);

  return dialog;
}

function loadBalances(dialog, account, refreshButton) {
  // Add loading state
  if (refreshButton) {
    refreshButton.classList.add('loading');
    refreshButton.disabled = true;
  }

  // Get or create items container
  let itemsContainer = dialog.querySelector('.credit-balance-items');
  if (!itemsContainer) {
    itemsContainer = document.createElement('div');
    itemsContainer.className = 'credit-balance-items';
    dialog.appendChild(itemsContainer);
  }

  // Clear previous balance items
  itemsContainer.innerHTML = '';

  // Fetch and display balances
  fetch(`${API_BASE_URL}/${FAVA_LEDGER_SLUG}/extension/LedgerDataApi/get_balance?account=${account}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Extension-Key': 'your-secret-key-here'
    },
    credentials: 'include'
  })
    .then(response => response.json())
    .then(data => {
      Object.entries(data).forEach(([account, balance]) => {
        const item = document.createElement('div');
        item.className = 'credit-balance-item';

        // Extract account name after last colon
        const accountParts = account.split(':');
        const accountName = accountParts.slice(-2).join(':');

        // Format balance as currency
        const absBalance = Math.abs(balance);
        const formattedBalance = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD'
        }).format(absBalance);

        // Create account name span
        const nameSpan = document.createElement('span');
        nameSpan.className = 'credit-balance-account-name';
        nameSpan.textContent = accountName;

        // Create amount span with click to highlight
        const amountSpan = document.createElement('span');
        amountSpan.className = `credit-balance-amount ${balance < 0 ? 'negative' : 'positive'}`;
        amountSpan.textContent = `${balance < 0 ? '-' : ''}${formattedBalance}`;
        amountSpan.title = 'Click to highlight on page';
        amountSpan.onclick = () => highlightBalanceOnPage(balance);

        item.appendChild(nameSpan);
        item.appendChild(amountSpan);
        itemsContainer.appendChild(item);
      });

      // Add extract buttons based on page content
      if (findTextInPage('American Express Rewards Checking')) {
        const item = document.createElement('div');
        item.className = 'credit-balance-item';
        const extractButton = document.createElement('button');
        extractButton.textContent = 'Extract Amex';
        extractButton.onclick = () => extractAmexChecking();
        item.appendChild(extractButton);
        itemsContainer.appendChild(item);
      }

      if (window.location.href.startsWith("https://robinhood.com/account/history")) {
        const item = document.createElement('div');
        item.className = 'credit-balance-item';
        const extractButton = document.createElement('button');
        extractButton.textContent = 'Extract Robinhood';
        extractButton.onclick = () => extractRobinhood();
        item.appendChild(extractButton);
        itemsContainer.appendChild(item);
      }

      if (window.location.host === "secure.future.green") {
        const item = document.createElement('div');
        item.className = 'credit-balance-item';
        const extractButton = document.createElement('button');
        extractButton.textContent = 'Extract Future';
        extractButton.onclick = () => extractFuture();
        item.appendChild(extractButton);
        itemsContainer.appendChild(item);
      }
    })
    .catch(error => {
      console.error('Error fetching balances:', error);
      const errorDiv = document.createElement('div');
      errorDiv.style.color = '#ef4444';
      errorDiv.style.padding = '8px';
      errorDiv.style.fontSize = '12px';
      errorDiv.textContent = 'Error loading balances';
      itemsContainer.appendChild(errorDiv);
    })
    .finally(() => {
      // Remove loading state
      if (refreshButton) {
        refreshButton.classList.remove('loading');
        refreshButton.disabled = false;
      }
    });
}
