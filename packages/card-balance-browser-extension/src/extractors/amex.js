import { displayDialog } from '../utils.js';

export function extractAmexChecking() {
  let rows = document.querySelectorAll("table tbody tr");

  // skip first one
  rows = Array.from(rows);
  // .slice(1);

  let data = rows.map(row => {
    let cells = row.querySelectorAll('td');
    if (cells.length < 4) {
      return null;
    }
    let merchant = "";
    if (cells.length < 2 || !cells[1].innerText.split('\n')[1]) {
      merchant = toTitleCase(cells[1].innerText.split('\n')[0]);
    } else {
      merchant = toTitleCase(cells[1].innerText.split('\n')[1]);
    }
    return {
      date: convertDate(cells[0].innerText),
      // description: cells[2].innerText.split('\n')[0],
      merchant: merchant,
      amount: cells[2].innerText.replace('$', '') + " USD"
    }
  })

  // reverse the data
  data = data.filter(d => d !== null).reverse();

  let output = [];
  // format data into beancount format
  data.forEach(d => {
    output.push(`${d.date} * "${d.merchant}" ""`);
    output.push(`  Assets:Checking:Amex  ${d.amount}`);
    output.push(`  Assets:Pending-Transfer`);
    output.push("")
  })
  displayDialog(output);
}

function convertDate(inputDate) {
  // Define the year 
  const year = new Date().getFullYear();

  // Split the input date into month and day
  const [monthStr, day] = inputDate.split(' ');

  // Create a map of month abbreviations to month numbers
  const monthMap = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12'
  };

  // Get the month number from the map
  const month = monthMap[monthStr];

  // Format the date as YYYY-MM-DD
  const formattedDate = `${year}-${month}-${day.padStart(2, '0')}`;

  return formattedDate;
}

function toTitleCase(str) {
  if (!str) return "";
  return str.toLowerCase().split(' ').map(word => {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}