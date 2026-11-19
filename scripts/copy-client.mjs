// Copy the hand-written browser bundle next to the compiled host half.
import { copyFileSync, mkdirSync } from 'node:fs'
mkdirSync('lib', { recursive: true })
copyFileSync('client.js', 'lib/client.js')
