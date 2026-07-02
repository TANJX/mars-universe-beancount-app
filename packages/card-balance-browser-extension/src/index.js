import { createBalanceDialog } from "./balanceDialog.js"
import { injectStyles } from "./styles.js"

// Inject styles
injectStyles()

const url = window.location.host
let account = null
if (url.includes("americanexpress")) {
  account = "amex"
} else if (url.includes("chase")) {
  account = "chase"
} else if (url.includes("bankofamerica")) {
  account = "bofa"
} else if (url.includes("bilt")) {
  account = "bilt"
} else if (url.includes("discover")) {
  account = "discover"
} else if (url.includes("robinhood")) {
  account = "robinhood"
} else if (url.includes("future")) {
  account = "future"
} else if (url.includes("td.com") || url.includes("tdbank.com")) {
  account = "td"
}

if (account) {
  console.log("account", account)
  // checkApiAvailability().then(isAvailable => {
  // if (isAvailable) {
  createBalanceDialog(account)
  // } else {
  // console.warn('Balance API is not available');
  // }
  // });
}
