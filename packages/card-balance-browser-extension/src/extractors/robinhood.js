import { displayDialog } from '../utils.js';

export function extractRobinhood() {
  // get page url
  const accountType = document.querySelector("button#downshift-1-toggle-button")?.innerText || "";
  let entries = []
  let dateRegex = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/g
  let hourRegex = /^\d{1,2}h$/g
  let minuteRegex = /^\d{1,2}m$/g

  let year = (new Date()).getFullYear()

  for (const transaction of document.querySelectorAll('.rh-expandable-item-a32bb9ad')) {
    const entry = {}

    // Use data-testid selectors for robustness against CSS class changes
    const header = transaction.querySelector('[data-testid="rh-ExpandableItem-buttonContent"]');
    if (!header) continue;
    const containerDiv = header.querySelector(':scope > div');
    if (!containerDiv || containerDiv.children.length < 2) continue;
    const leftDiv = containerDiv.children[0];
    const rightDiv = containerDiv.children[1];

    entry.info = leftDiv.querySelector('h3')?.textContent;
    if (!entry.info) continue;

    const infoLower = entry.info.toLowerCase();
    if (infoLower.endsWith("buy") || infoLower.endsWith("sell") || infoLower.endsWith("recurring investment")) {
      entry.transaction = true;
    }

    // date
    let dateStr = leftDiv.querySelector(':scope > span')?.textContent || '';
    if (dateStr.includes("·")) {
      // Individual · Jul 25, 2024
      if (dateStr.includes("Traditional IRA") && !dateStr.includes("Transfer to")) {
        entry.ira = "Traditional";
      } else if (dateStr.includes("Roth IRA") && !dateStr.includes("Transfer to")) {
        entry.ira = "Roth";
      }
      dateStr = dateStr.split(" · ")[1];
    }

    // Check URL path for account type
    // const path = window.location.href;
    if (accountType === 'Roth IRA') {
      entry.ira = 'Roth';
    } else if (accountType === 'Traditional IRA') {
      entry.ira = 'Traditional';
    } else if (accountType === 'Individual') {
      entry.ira = undefined;
    }

    if (dateStr.match(dateRegex)) {
      if (dateStr.length <= 6) {
        dateStr = `${dateStr}, ${year}`
      }
      dateStr = (new Date(Date.parse(dateStr))).toISOString().slice(0, 10);
    } else if (dateStr.match(hourRegex) || dateStr.match(minuteRegex)) {
      // today
      dateStr = (new Date()).toISOString().slice(0, 10);
    }
    entry.date = dateStr;

    // amount
    let costStr = rightDiv.querySelector('h3')?.textContent || '';
    if (transaction.textContent.includes("Canceled") || transaction.textContent.includes("Placed")) {
      continue;
    }
    if (costStr.startsWith("$")) {
      costStr = costStr.substring(1)
    } else if (costStr.startsWith("-$")) {
      costStr = `-${costStr.substring(2)}`
    } else if (costStr.startsWith("+$")) {
      costStr = costStr.substring(2)
    }
    entry.cost = costStr;

    const rightSpan = rightDiv.querySelector(':scope > span');
    if (rightSpan && rightSpan.textContent.trim())
      entry.amountInfo = rightSpan.textContent;
    else {
      transaction.querySelectorAll('[data-testid="cell-label"]').forEach((el) => {
        if (el.textContent.toLowerCase().includes("filled quantity")) {
          entry.amountInfo = el.querySelector('.css-y3z1hq')?.textContent;
        }
      })
    }

    transaction.querySelectorAll('[data-testid="cell-label"]').forEach((el) => {
      if (el.textContent.includes("Symbol")) {
        entry.symbol = el.querySelector('.css-y3z1hq')?.textContent;
      }
    })

    if (transaction.textContent.includes("Deposit from")) {
      const newEntry = { ...entry };
      newEntry.info = "Deposit to individual account from ";
      console.warn(transaction);
    }
    entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });

  let results = [];
  // Filter out entries that should be skipped
  entries = entries.filter(entry => {
    if (entry.transaction && (!entry.amountInfo || entry.amountInfo.split(" ").length <= 3)) {
      console.warn("Skipping", entry);
      return false;
    }
    return true;
  });

  console.log("entries", entries);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    console.log("entry", entry);
    if (entry.transaction) {
      const symbol = entry.symbol;
      const description = `${entry.info}`;
      const amount = parseFloat(entry.amountInfo.split(" ")[0]);
      const price = parseFloat(entry.amountInfo.split(" ")[3].substring(1));
      const cost = Math.round(amount * price * 100) / 100;

      if (entry.ira) {
        // Group IRA investments within one day
        if (i === 0 || entries[i - 1].date !== entry.date || !entries[i - 1].transaction || entries[i - 1].ira !== entry.ira) {
          results.push(`${entry.date} * "IRA Contribution"`);
        }
        results.push(`  Assets:Investment:Robinhood:${entry.ira}-IRA:${symbol}          ${amount} ${symbol} {${price} USD}`);

        // If it's the last entry of the day or the next entry is not an IRA investment
        if (i === entries.length - 1 || entries[i + 1].date !== entry.date || !entries[i + 1].transaction || entries[i + 1].ira !== entry.ira) {
          // Calculate the total cost for the day
          let totalCost = 0;
          for (let j = i; j >= 0 && entries[j].date === entry.date && entries[j].transaction && entries[j].ira === entry.ira; j--) {
            const entryAmount = parseFloat(entries[j].amountInfo.split(" ")[0]);
            const entryPrice = parseFloat(entries[j].amountInfo.split(" ")[3].substring(1));
            totalCost += Math.round(entryAmount * entryPrice * 100) / 100;
          }
          results.push(`  Assets:Pending-Transfer                           -${totalCost.toFixed(2)} USD`);
          // results.push(`  Equity:Others:Rounding`);
          results.push("");
        }
      } else {
        results.push(`${entry.date} * "${description} ${entry.amountInfo}"`);
        if (entry.info.toLowerCase().endsWith("buy") || entry.info.toLowerCase().endsWith("recurring investment")) {
          results.push(`  Assets:Investment:Robinhood:Brokerage:${symbol}          ${amount} ${symbol} {${price} USD}`);
          results.push(`  Assets:Investment:Robinhood:Brokerage:USD          -${cost} USD`);
          // results.push(`  Equity:Others:Rounding`);
        } else {
          results.push(`  Assets:Investment:Robinhood:Brokerage:${symbol}          -${amount} ${symbol} {} @ ??? USD`);
          results.push(`  Assets:Investment:Robinhood:Brokerage:USD          ${cost} USD`);
          results.push(`  Income:Trading:Stock`);
        }
        results.push("");
      }
    }
    // Withdrawal from individual account to Adv Plus Banking - 0213,Individual · Jul 25, 2024
    // -$3,000.00,-$3,000.00,-1% boost,
    else if (entry.info.startsWith("Withdrawal")) {
      results.push(`${entry.date} * "${entry.info}"`);
      results.push(`  Assets:Investment:Robinhood:Brokerage:USD          ${entry.cost} USD`);
      results.push(`  Assets:Pending-Transfer`);
      results.push("");
    }
    // Deposit to individual account from 
    else if (entry.info.startsWith("Deposit to individual account from ")) {
      results.push(`${entry.date} * "${entry.info}"`);
      results.push(`  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`);
      results.push(`  Assets:Pending-Transfer`);
      results.push("");
    }
    // Robinhood Gold
    else if (entry.info.startsWith("Robinhood Gold")) {
      results.push(`${entry.date} * "${entry.info}"`);
      results.push(`  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`);
      results.push(`  Expenses:Subscription`);
      results.push("");
    }
    // Interest
    else if (entry.info.startsWith("Interest")) {
      results.push(`${entry.date} * "${entry.info}"`);
      results.push(`  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`);
      results.push(`  Income:Interest:Robinhood`);
      results.push("");
    }
    // Interest
    else if (entry.info.startsWith("Gold deposit boost payout")) {
      results.push(`${entry.date} * "${entry.info}"`);
      results.push(`  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`);
      results.push(`  Income:Rebate:Robinhood`);
      results.push("");
    }
    // Dividend
    else if (entry.info.startsWith("Dividend from")) {
      results.push(`${entry.date} * "${entry.info}"`);
      if (entry.ira === "Roth" || accountType === "Roth IRA") {
        results.push(`  Assets:Investment:Robinhood:Roth-IRA:USD          ${entry.cost} USD`);
      } else if (entry.ira === "Traditional" || accountType === "Traditional IRA") {
        results.push(`  Assets:Investment:Robinhood:Traditional-IRA:USD          ${entry.cost} USD`);
      } else {
        results.push(`  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`);
      }
      results.push(`  Income:Trading:Dividend`);
      results.push("");
    }
    else if (entry.info.endsWith("Stock Lending Payment")) {
      results.push(`${entry.date} * "${entry.info}"`);
      if (entry.ira === "Roth" || accountType === "Roth IRA") {
        results.push(`  Assets:Investment:Robinhood:Roth-IRA:USD          ${entry.cost} USD`);
      } else if (entry.ira === "Traditional" || accountType === "Traditional IRA") {
        results.push(`  Assets:Investment:Robinhood:Traditional-IRA:USD          ${entry.cost} USD`);
      } else {
        results.push(`  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`);
      }
      results.push(`  Income:Trading:Stock`);
      results.push("");
    }
    else {
      results.push(`${entry.date} ! "${entry.info}"`);
      if (entry.ira === "Roth" || accountType === "Roth IRA") {
        results.push(`  Assets:Investment:Robinhood:Roth-IRA:USD          ${entry.cost} USD`);
      } else if (entry.ira === "Traditional" || accountType === "Traditional IRA") {
        results.push(`  Assets:Investment:Robinhood:Traditional-IRA:USD          ${entry.cost} USD`);
      } else {
        results.push(`  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`);
      }
      results.push(``);
      results.push("");
    }
  }
  displayDialog(results);
}
