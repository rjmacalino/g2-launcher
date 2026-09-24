// Generate a sideload QR pointing at this machine's LAN address.
//
// This exists because the obvious version is wrong in a way that looks right.
// `evenhub qr --url http://localhost:5173` produces a QR the phone happily scans
// and then fails to load, because `localhost` on the phone means the phone. The
// dev server is on this machine, so the QR has to carry an address the phone can
// route to.
//
// Picking that address automatically is not trivial either. A dev box typically
// has several IPv4 addresses and most of them are useless here:
//
//   - 169.254.x.x is link-local, assigned when an adapter has no DHCP lease
//   - virtual adapters (WSL, Hyper-V, Docker, VirtualBox, VMware) are real
//     addresses on networks the phone is not on. WSL in particular hands out
//     172.23.x.x, which is inside a private range and so survives a naive filter
//
// So candidates are filtered by adapter name and address range, then ranked. All
// candidates are printed rather than just the winner, because when the guess is
// wrong the fix is obvious only if you can see what else was available.

import { networkInterfaces } from 'node:os'
import { spawnSync } from 'node:child_process'

const PORT = process.env.PORT ?? '5173'

const VIRTUAL_ADAPTER_PATTERN = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|loopback|bluetooth/i

function candidates() {
  const found = []
  const interfaces = networkInterfaces()

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue
    if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue

    for (const address of addresses) {
      if (address.family !== 'IPv4') continue
      if (address.internal) continue
      // Link-local. An adapter with one of these has no working DHCP lease, so it
      // is plugged in but not on a network.
      if (address.address.startsWith('169.254.')) continue

      found.push({ name, ip: address.address })
    }
  }

  return found
}

// Home and office LANs are overwhelmingly 192.168.x.x, so that ranks first.
// 10.x is the next most likely to be a real network rather than a virtual one.
function rank(ip) {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  return 2
}

const found = candidates().sort((a, b) => rank(a.ip) - rank(b.ip))

if (found.length === 0) {
  console.error('No usable LAN address found.')
  console.error('')
  console.error('Every adapter was virtual, link-local, or internal. Check that this')
  console.error('machine is actually on WiFi, then pass an address by hand:')
  console.error('')
  console.error(`  npx evenhub qr --ip <your-ip> --port ${PORT} --http`)
  process.exit(1)
}

const chosen = found[0]

console.log('LAN addresses found:')
for (const entry of found) {
  const marker = entry === chosen ? '->' : '  '
  console.log(`  ${marker} ${entry.ip.padEnd(15)} ${entry.name}`)
}
console.log('')
console.log(`Using http://${chosen.ip}:${PORT}`)
console.log('')
console.log('Your phone must be on this same network. If the page does not load,')
console.log('try another address from the list above, or check that the firewall')
console.log(`allows inbound connections on port ${PORT}.`)
console.log('')

// Validate before this reaches a shell. The values come from the OS and from an
// env var rather than from user input, so this is belt and braces, but a string
// heading for `shell: true` gets checked on principle.
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(chosen.ip)) {
  console.error(`Refusing to use a malformed address: ${chosen.ip}`)
  process.exit(1)
}
if (!/^\d{1,5}$/.test(String(PORT))) {
  console.error(`Refusing to use a malformed port: ${PORT}`)
  process.exit(1)
}

// shell: true is required, not stylistic. The evenhub CLI resolves to a .cmd
// shim on Windows, and Node refuses to spawn .cmd without a shell since the fix
// for CVE-2024-27980. Without it this fails silently: the script prints the right
// address, the CLI never runs, and no QR appears.
const result = spawnSync(`npx evenhub qr --ip ${chosen.ip} --port ${PORT} --http`, {
  stdio: 'inherit',
  shell: true,
})

if (result.status !== 0) {
  console.error('')
  console.error('QR generation failed. Fall back to running it directly:')
  console.error(`  npx evenhub qr --ip ${chosen.ip} --port ${PORT} --http`)
}

process.exit(result.status ?? 1)
