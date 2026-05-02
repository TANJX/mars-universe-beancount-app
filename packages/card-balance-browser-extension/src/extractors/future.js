import { displayDialog } from '../utils.js';

function formatDate(rawDate) {
  // Assume input is "Month Day" (e.g., "December 15")
  const date = new Date(`${rawDate} ${new Date().getFullYear()}`);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0'); // Zero-padded month
  const day = String(date.getDate()).padStart(2, '0'); // Zero-padded day
  return `${year}-${month}-${day}`;
}

// Helper function to convert string to Title Case
function toTitleCase(str) {
  return str
    .toLowerCase()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function extractFuture() {
  let transactions = document.querySelectorAll(
    'main  > .w-full .flex-1.min-w-0'
  );

  let result = [];
  Array.from(transactions).reverse().forEach((transaction) => {
    // Extract the description
    const descriptionElement = transaction.querySelector(
      'div.flex.justify-between.items-center > .flex.flex-col > div:first-child'
    );
    const descriptionRaw = descriptionElement ? descriptionElement.innerText.trim() : 'Unknown';
    let description = toTitleCase(descriptionRaw);

    // Extract the amount
    const amountElement = transaction.querySelector(
      'div.flex.justify-between.items-center > .flex.flex-col:last-child'
    );
    const amountText = amountElement ? amountElement.innerText.trim() : '$0.00';
    const amount = parseFloat(amountText.replace('$', ''));

    // Extract the date
    const dateElement = transaction.querySelector(
      'div.flex.justify-between.items-center > .flex.flex-col > div:last-child'
    );
    const rawDate = dateElement ? dateElement.innerText.trim() : 'Unknown Date';
    if (rawDate === 'Unknown Date' || rawDate === 'Pending' || rawDate === 'Declined') {
      return;
    }

    // Convert date to YYYY-MM-DD format (assuming MM DD format in input)
    const formattedDate = formatDate(rawDate);

    let expenseAccount = 'Expenses:Pending';
    if (descriptionRaw.includes('MTA*NYCT PAYGO') || descriptionRaw.includes('OMNY')) {
      expenseAccount = 'Expenses:Transportation:Public';
    } else if (descriptionRaw === '' && amount > 0) {
      expenseAccount = 'Income:Rebate:Future';
      description = `Cash Back For ${Math.round(amount * 100)} Points`;
    } else if (descriptionRaw === 'ASTRA*Future') {
      expenseAccount = 'Assets:Pending-Transfer';
    } else if (descriptionRaw.toLowerCase().includes('tesla')) {
      expenseAccount = 'Expenses:Transportation:Driving';
    }

    // Push to the result
    result.push(`${formattedDate} * "${description}" ""`);
    result.push(`  Assets:Checking:Future                    ${amount.toFixed(2)} USD`);
    result.push(`  ${expenseAccount}`);
    result.push("");
  });

  // Join all transactions with new lines and return
  displayDialog(result);
}
