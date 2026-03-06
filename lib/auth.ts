import { createBrowserClient } from './supabase'

export function getAuthClient() {
  return createBrowserClient()
}
