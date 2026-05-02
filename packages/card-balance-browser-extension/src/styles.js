export function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .credit-balance-dialog {
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 12px;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.8);
      z-index: 100000;
      min-width: 260px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      color: #1a1a1a;
      cursor: move;
      transition: box-shadow 0.2s ease;
    }

    .credit-balance-dialog:hover {
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15), 0 4px 12px rgba(0, 0, 0, 0.1);
    }

    .credit-balance-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 2px solid rgba(0, 0, 0, 0.06);
    }

    .credit-balance-header h3 {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.3px;
      margin: 0;
      color: #1a1a1a;
    }

    .credit-balance-controls {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .credit-balance-refresh {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border: none;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      color: white;
      font-size: 13px;
    }

    .credit-balance-refresh:hover {
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .credit-balance-refresh:active {
      transform: scale(0.95);
    }

    .credit-balance-refresh.loading {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .credit-balance-close {
      background: rgba(0, 0, 0, 0.05);
      border: none;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      color: #666;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }

    .credit-balance-close:hover {
      background: rgba(0, 0, 0, 0.1);
      color: #333;
    }

    .credit-balance-items {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .credit-balance-item {
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.02);
      font-size: 12px;
      transition: all 0.2s ease;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .credit-balance-item:hover {
      background: rgba(0, 0, 0, 0.04);
    }

    .credit-balance-account-name {
      font-weight: 500;
      color: #333;
      font-size: 12px;
    }

    .credit-balance-amount {
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      transition: color 0.2s ease;
    }

    .credit-balance-amount.negative {
      color: #ef4444;
    }

    .credit-balance-amount.positive {
      color: #10b981;
    }

    .credit-balance-item button {
      width: 100%;
      text-align: center;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
      font-size: 11px;
      transition: all 0.2s ease;
    }

    .credit-balance-item button:hover {
      box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4);
    }

    .credit-balance-item button:active {
      transform: translateY(0);
    }

    .balance-highlight {
      background: rgba(102, 126, 234, 0.3) !important;
      border-radius: 3px;
      padding: 2px 4px;
      box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
      transition: all 0.2s ease;
    }
  `;
  document.head.appendChild(style);
}
