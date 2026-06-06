# KAIROS Failure Taxonomy

Complete reference of every failure mode the system detects,
classifies, and handles autonomously.

---

## 1. blockhash_expired

**What it is:**
Every Solana transaction embeds a blockhash that is valid for
exactly 150 slots (~60 seconds). If the transaction is not
processed within that window, the runtime rejects it.

**Real error string from RPC:**