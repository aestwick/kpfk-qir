#!/bin/bash
# usage: sbq.sh "select ..."   — SQL via the proxy-injected, read-only Supabase MCP
# Works only inside a Claude Code cloud session: the session proxy injects the
# Supabase credential for mcp.supabase.com and the server enforces read_only=true.
# Needs curl + jq. Output is the raw MCP text payload (JSON with an untrusted-data wrapper).
U='https://mcp.supabase.com/mcp?project_ref=czjhwhfqohpmwprhasve&read_only=true'; H='Accept: application/json, text/event-stream'
SID=$(curl -s -m 20 -D - -o /dev/null -X POST "$U" -H 'Content-Type: application/json' -H "$H" -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}' | grep -i '^mcp-session-id' | awk '{print $2}' | tr -d '\r')
curl -s -m 20 -X POST "$U" -H 'Content-Type: application/json' -H "$H" -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
BODY=$(jq -n --arg q "$1" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"execute_sql",arguments:{query:$q}}}')
curl -s -m 60 -X POST "$U" -H 'Content-Type: application/json' -H "$H" -H "Mcp-Session-Id: $SID" -d "$BODY" | jq -r '.result.content[0].text'
