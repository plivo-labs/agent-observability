'use client'

// Importing this module installs the browser fetch-mock exactly once, at
// import time — BEFORE any provider effect fires its fetch('/api/...').
import { installMockFetch } from '@/lib/install-mock-fetch'

installMockFetch()

export {}
