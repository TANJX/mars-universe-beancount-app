import { displayDialog } from "../utils.js"

// Robinhood renders share count + execution price as e.g.
// "28.580559 shares at $33.27" (header right span when filled, or the
// "Filled quantity" cell-label as fallback). Numbers may contain commas.
function parseSharesAndPrice(text) {
  if (!text) return null
  const m = text.match(/([\d,]+\.?\d*)\s+shares?\s+at\s+\$([\d,]+\.?\d*)/i)
  if (!m) return null
  return {
    amount: parseFloat(m[1].replace(/,/g, "")),
    price: parseFloat(m[2].replace(/,/g, "")),
  }
}

// Detail rows render the label and the value as two sibling spans with stable
// css-* classes: <span class="css-v72tci">Event</span> … <span
// class="css-y3z1hq">Will Spain win …</span>. Match the label exactly so
// "Total" can't shadow "Total cost".
function getCell(transaction, label) {
  for (const el of transaction.querySelectorAll('[data-testid="cell-label"]')) {
    const name = el.querySelector(".css-v72tci")?.textContent.trim()
    if (name === label) {
      return el.querySelector(".css-y3z1hq")?.textContent.trim()
    }
  }
  return undefined
}

// "$0.28" / "-$11.68" / "+$19.00" / "1,402.43" -> Number; "Free" -> null.
function parseMoney(text) {
  if (!text) return null
  const n = Number(text.replace(/[$,+\s]/g, ""))
  return Number.isFinite(n) ? n : null
}

export function extractRobinhood() {
  // The account selector button uses dynamic downshift IDs (e.g. downshift-1,
  // downshift-7), so locate it by the recognized label text instead.
  let accountType = ""
  for (const btn of document.querySelectorAll(
    'button[id^="downshift-"][id$="-toggle-button"]'
  )) {
    const label = (btn.innerText || "").trim()
    if (
      label === "Roth IRA" ||
      label === "Traditional IRA" ||
      label === "Individual"
    ) {
      accountType = label
      break
    }
  }
  let entries = []
  const dateRegex = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/g
  const hourRegex = /^\d{1,2}h$/g
  const minuteRegex = /^\d{1,2}m$/g

  const year = new Date().getFullYear()

  for (const transaction of document.querySelectorAll(
    ".rh-expandable-item-a32bb9ad"
  )) {
    const entry = {}

    // Use data-testid selectors for robustness against CSS class changes
    const header = transaction.querySelector(
      '[data-testid="rh-ExpandableItem-buttonContent"]'
    )
    if (!header) continue
    const containerDiv = header.querySelector(":scope > div")
    if (!containerDiv || containerDiv.children.length < 2) continue
    const leftDiv = containerDiv.children[0]
    const rightDiv = containerDiv.children[1]

    entry.info = leftDiv.querySelector("h3")?.textContent
    if (!entry.info) continue

    // Event-contract (prediction market) rows. Detect them by the detail cells
    // unique to a contract order/settlement, plus the "19 contracts @60¢"
    // quantity string. Deliberately NOT keyed off an info suffix: a contract
    // row reads "Spain Limit Buy" / "Spain Payout", and "payout" alone would
    // hijack the unrelated "Gold deposit boost payout" row below.
    const qtyHint = rightDiv.querySelector(":scope > span")?.textContent || ""
    if (
      getCell(transaction, "Event") !== undefined ||
      getCell(transaction, "Settlement price") !== undefined ||
      /\bcontracts?\s*@/i.test(qtyHint)
    ) {
      entry.contract = true
      entry.fee = parseMoney(getCell(transaction, "Commission and fees"))
      entry.quantity = getCell(transaction, "Quantity")
      entry.settlementPrice = getCell(transaction, "Settlement price")
    }

    const infoLower = entry.info.toLowerCase()
    // A contract row must never be flagged `transaction` — that path parses
    // "N shares at $X", which contracts don't have, so the filter below would
    // silently drop them.
    if (
      !entry.contract &&
      (infoLower.endsWith("buy") ||
        infoLower.endsWith("sell") ||
        infoLower.endsWith("recurring investment"))
    ) {
      entry.transaction = true
    }

    // date
    let dateStr = leftDiv.querySelector(":scope > span")?.textContent || ""
    if (dateStr.includes("·")) {
      // Individual · Jul 25, 2024
      if (
        dateStr.includes("Traditional IRA") &&
        !dateStr.includes("Transfer to")
      ) {
        entry.ira = "Traditional"
      } else if (
        dateStr.includes("Roth IRA") &&
        !dateStr.includes("Transfer to")
      ) {
        entry.ira = "Roth"
      }
      const parts = dateStr.split(" · ")
      // Contract rows prepend two extra segments: "Yes · ESP to win · Jul 19"
      // (side · market · date) vs a stock row's "Individual · Jul 22".
      if (entry.contract && parts.length >= 3) {
        entry.side = parts[0].trim()
        entry.market = parts.slice(1, -1).join(" · ").trim()
      }
      // Always take the LAST segment — the date is rightmost in every variant.
      dateStr = parts[parts.length - 1]
    }

    // Check URL path for account type
    // const path = window.location.href;
    if (accountType === "Roth IRA") {
      entry.ira = "Roth"
    } else if (accountType === "Traditional IRA") {
      entry.ira = "Traditional"
    } else if (accountType === "Individual") {
      entry.ira = undefined
    }

    if (dateStr.match(dateRegex)) {
      if (dateStr.length <= 6) {
        dateStr = `${dateStr}, ${year}`
      }
      dateStr = new Date(Date.parse(dateStr)).toISOString().slice(0, 10)
    } else if (dateStr.match(hourRegex) || dateStr.match(minuteRegex)) {
      // today
      dateStr = new Date().toISOString().slice(0, 10)
    }
    entry.date = dateStr

    // amount
    let costStr = rightDiv.querySelector("h3")?.textContent || ""
    if (
      transaction.textContent.includes("Canceled") ||
      transaction.textContent.includes("Placed") ||
      transaction.textContent.includes("Failed")
    ) {
      continue
    }
    if (costStr.startsWith("$")) {
      costStr = costStr.substring(1)
    } else if (costStr.startsWith("-$")) {
      costStr = `-${costStr.substring(2)}`
    } else if (costStr.startsWith("+$")) {
      costStr = costStr.substring(2)
    }
    // Strip thousands separators — parseFloat("1,402.43") returns 1.
    entry.cost = costStr.replace(/,/g, "")

    const rightSpan = rightDiv.querySelector(":scope > span")
    if (rightSpan?.textContent.trim()) entry.amountInfo = rightSpan.textContent
    else {
      transaction
        .querySelectorAll('[data-testid="cell-label"]')
        .forEach((el) => {
          if (el.textContent.toLowerCase().includes("filled quantity")) {
            entry.amountInfo = el.querySelector(".css-y3z1hq")?.textContent
          }
        })
    }

    transaction.querySelectorAll('[data-testid="cell-label"]').forEach((el) => {
      if (el.textContent.includes("Symbol")) {
        entry.symbol = el.querySelector(".css-y3z1hq")?.textContent
      }
    })

    if (transaction.textContent.includes("Deposit from")) {
      const newEntry = { ...entry }
      newEntry.info = "Deposit to individual account from "
      console.warn(transaction)
    }
    entries.push(entry)
  }

  // Sort by date asc, then put all buys before sells within a day so that
  // same-direction transactions end up adjacent for grouping below.
  // A contract settling the same day it was bought ranks last, so the buy that
  // opened the position is emitted before the payout that closes it.
  const dayRank = (e) => {
    const info = e.info?.toLowerCase() || ""
    if (e.contract && info.endsWith("payout")) return 2
    if (info.endsWith("sell")) return 1
    return 0
  }
  entries.sort((a, b) => {
    if (a.date < b.date) return -1
    if (a.date > b.date) return 1
    return dayRank(a) - dayRank(b)
  })

  const results = []
  // Drop transaction rows we couldn't parse a fill for (failed/pending/etc.)
  entries = entries.filter((entry) => {
    if (entry.transaction) {
      const parsed = parseSharesAndPrice(entry.amountInfo)
      if (!parsed) {
        console.warn("Skipping (no shares/price)", entry)
        return false
      }
      entry._parsed = parsed
    }
    return true
  })

  console.log("entries", entries)

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    console.log("entry", entry)
    if (entry.transaction) {
      const symbol = entry.symbol
      const description = `${entry.info}`
      const { amount, price } = entry._parsed
      // Use Robinhood's displayed proceeds (entry.cost) rather than
      // shares × shown_price. The shown price is rounded to 2 decimals,
      // so multiplying it back drifts by a few cents on larger fills.
      // The DISPLAYED sign is unreliable — IRA contributions render buys as
      // a positive "$X" with no leading "-", which dropped the minus on the
      // USD leg. So derive the USD-leg sign from the trade direction instead:
      // a buy is a cash outflow (negative), a sell is proceeds (positive).
      const costMagnitude = Math.abs(Number(entry.cost))
      const direction = entry.info.toLowerCase().endsWith("sell")
        ? "sell"
        : "buy"
      const signedUsd = direction === "sell" ? costMagnitude : -costMagnitude

      if (entry.ira) {
        const sharesAcct = `Assets:Investment:Robinhood:${entry.ira}-IRA:${symbol}`
        const usdAcct = `Assets:Investment:Robinhood:${entry.ira}-IRA:USD`

        if (direction === "sell") {
          // Sells are emitted one-per-transaction so each lot disposal is
          // its own entry — keeps gain/loss attribution clean per symbol.
          results.push(`${entry.date} * "${entry.info}"`)
          results.push(
            `  ${sharesAcct}          -${amount} ${symbol} {} @ ${price} USD`
          )
          results.push(`  ${usdAcct}          ${signedUsd.toFixed(2)} USD`)
          results.push(`  Income:Trading:Stock`)
          results.push("")
        } else {
          // Buys still group across same-day same-IRA so contributions
          // show as one entry rather than N tiny rebalance rows.
          const sameGroup = (other) =>
            other?.transaction &&
            other.ira === entry.ira &&
            other.date === entry.date &&
            !other.info.toLowerCase().endsWith("sell")

          const isFirst = i === 0 || !sameGroup(entries[i - 1])
          const isLast = i === entries.length - 1 || !sameGroup(entries[i + 1])

          if (isFirst) {
            results.push(`${entry.date} * "IRA Contribution"`)
          }
          results.push(
            `  ${sharesAcct}          ${amount} ${symbol} {${price} USD}`
          )

          if (isLast) {
            // Sum the magnitudes of every fill in the same-day buy group, then
            // emit as a negative USD leg — a contribution is a cash outflow,
            // regardless of how Robinhood signed each displayed amount.
            let totalCost = 0
            for (let j = i; j >= 0 && sameGroup(entries[j]); j--) {
              totalCost += Math.abs(Number(entries[j].cost))
            }
            results.push(`  ${usdAcct}          ${(-totalCost).toFixed(2)} USD`)
            results.push("")
          }
        }
      } else {
        results.push(`${entry.date} * "${description} ${entry.amountInfo}"`)
        if (direction === "buy") {
          results.push(
            `  Assets:Investment:Robinhood:Brokerage:${symbol}          ${amount} ${symbol} {${price} USD}`
          )
          results.push(
            `  Assets:Investment:Robinhood:Brokerage:USD          ${signedUsd.toFixed(2)} USD`
          )
        } else {
          results.push(
            `  Assets:Investment:Robinhood:Brokerage:${symbol}          -${amount} ${symbol} {} @ ??? USD`
          )
          results.push(
            `  Assets:Investment:Robinhood:Brokerage:USD          ${signedUsd.toFixed(2)} USD`
          )
          results.push(`  Income:Trading:Stock`)
        }
        results.push("")
      }
    }
    // Event contracts (prediction markets), e.g. "Spain Limit Buy" then
    // "Spain Payout". Booked as pure P&L against Income:Trading:Stock: no
    // position is carried between buy and settlement, so the elided income leg
    // absorbs the stake going in and the proceeds coming out.
    else if (entry.contract) {
      const isPayout = entry.info.toLowerCase().endsWith("payout")
      // The header amount is fee-inclusive (it equals the "Total cost" cell).
      let costNum = parseMoney(entry.cost)
      if (costNum === null && isPayout) {
        // A worthless settlement can render a blank header — rebuild it from
        // the settlement cells so the entry still balances.
        const q = parseMoney(entry.quantity)
        const p = parseMoney(entry.settlementPrice)
        if (q !== null && p !== null) costNum = q * p
      }

      const detail = [entry.side, entry.market].filter(Boolean).join(" · ")
      const size = isPayout
        ? entry.quantity && entry.settlementPrice
          ? `${entry.quantity} @ ${entry.settlementPrice}`
          : null
        : entry.amountInfo?.trim()
      const narration = [size, detail].filter(Boolean).join(" · ")

      const flag = costNum === null ? "!" : "*"
      results.push(
        narration
          ? `${entry.date} ${flag} "${entry.info}" "${narration}"`
          : `${entry.date} ${flag} "${entry.info}"`
      )
      const posting = (account, amount) =>
        `  ${account.padEnd(41)}          ${amount} USD`
      results.push(
        posting(
          "Assets:Investment:Robinhood:Brokerage:USD",
          costNum === null ? "" : costNum.toFixed(2)
        )
      )
      // Break the commission out so the inferred income leg is the bare stake,
      // matching Robinhood's own pre-fee "Realized profit" figure.
      if (entry.fee) {
        results.push(posting("Expenses:Fee", entry.fee.toFixed(2)))
      }
      results.push(`  Income:Trading:Stock`)
      results.push("")
    }
    // Withdrawal from individual account to Adv Plus Banking - 0213,Individual · Jul 25, 2024
    // -$3,000.00,-$3,000.00,-1% boost,
    else if (entry.info.startsWith("Withdrawal")) {
      results.push(`${entry.date} * "${entry.info}"`)
      results.push(
        `  Assets:Investment:Robinhood:Brokerage:USD          ${entry.cost} USD`
      )
      results.push(`  Assets:Pending-Transfer`)
      results.push("")
    }
    // Deposit to individual account from
    else if (entry.info.startsWith("Deposit to individual account from ")) {
      results.push(`${entry.date} * "${entry.info}"`)
      results.push(
        `  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`
      )
      results.push(`  Assets:Pending-Transfer`)
      results.push("")
    }
    // Robinhood Gold
    else if (entry.info.startsWith("Robinhood Gold")) {
      results.push(`${entry.date} * "${entry.info}"`)
      results.push(
        `  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`
      )
      results.push(`  Expenses:Subscription`)
      results.push("")
    }
    // Interest
    else if (entry.info.startsWith("Interest")) {
      results.push(`${entry.date} * "${entry.info}"`)
      results.push(
        `  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`
      )
      results.push(`  Income:Interest:Robinhood`)
      results.push("")
    }
    // Interest
    else if (entry.info.startsWith("Gold deposit boost payout")) {
      results.push(`${entry.date} * "${entry.info}"`)
      results.push(
        `  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`
      )
      results.push(`  Income:Rebate:Robinhood`)
      results.push("")
    }
    // Dividend
    else if (
      entry.info.startsWith("Dividend from") ||
      entry.info.startsWith("Early Dividends from")
    ) {
      results.push(`${entry.date} * "${entry.info}"`)
      if (entry.ira === "Roth" || accountType === "Roth IRA") {
        results.push(
          `  Assets:Investment:Robinhood:Roth-IRA:USD          ${entry.cost} USD`
        )
      } else if (
        entry.ira === "Traditional" ||
        accountType === "Traditional IRA"
      ) {
        results.push(
          `  Assets:Investment:Robinhood:Traditional-IRA:USD          ${entry.cost} USD`
        )
      } else {
        results.push(
          `  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`
        )
      }
      results.push(`  Income:Trading:Dividend`)
      results.push("")
    }
    // Robinhood credit card rebate transfer
    else if (
      entry.info.startsWith("Transfer to individual from Robinhood credit card")
    ) {
      results.push(`${entry.date} * "${entry.info}"`)
      results.push(
        `  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`
      )
      results.push(`  Income:Rebate:Robinhood`)
      results.push("")
    } else if (entry.info.endsWith("Stock Lending Payment")) {
      results.push(`${entry.date} * "${entry.info}"`)
      if (entry.ira === "Roth" || accountType === "Roth IRA") {
        results.push(
          `  Assets:Investment:Robinhood:Roth-IRA:USD          ${entry.cost} USD`
        )
      } else if (
        entry.ira === "Traditional" ||
        accountType === "Traditional IRA"
      ) {
        results.push(
          `  Assets:Investment:Robinhood:Traditional-IRA:USD          ${entry.cost} USD`
        )
      } else {
        results.push(
          `  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`
        )
      }
      results.push(`  Income:Trading:Stock`)
      results.push("")
    } else {
      results.push(`${entry.date} ! "${entry.info}"`)
      if (entry.ira === "Roth" || accountType === "Roth IRA") {
        results.push(
          `  Assets:Investment:Robinhood:Roth-IRA:USD          ${entry.cost} USD`
        )
      } else if (
        entry.ira === "Traditional" ||
        accountType === "Traditional IRA"
      ) {
        results.push(
          `  Assets:Investment:Robinhood:Traditional-IRA:USD          ${entry.cost} USD`
        )
      } else {
        results.push(
          `  Assets:Investment:Robinhood:Brokerage:USD           ${entry.cost} USD`
        )
      }
      results.push(``)
      results.push("")
    }
  }
  displayDialog(results)
}
