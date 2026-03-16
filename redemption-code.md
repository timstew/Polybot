# Polymarket Redemption Integration

## Background

Polymarket positions are held in a Gnosis Safe proxy wallet on Polygon (chain 137).
Google OAuth / Magic.link wallets (signature_type=1) don't expose the underlying private key,
so you can't call `redeemPositions` on the Conditional Tokens contract programmatically.

**Solution**: Use an EOA wallet (signature_type=0) where you control the private key.
When you first trade via the CLOB API, Polymarket creates a 1-of-1 Safe proxy that your
EOA controls — giving you full on-chain authority including redemption.

## Wallet Setup (One-Time)

### 1. Generate EOA Wallet

```python
from eth_account import Account
acct = Account.create()
print(f"Address:     {acct.address}")
print(f"Private key: {acct.key.hex()}")
# Save the private key securely — it controls all your funds
```

### 2. Fund on Polygon

Send to your EOA address on Polygon:
- **POL** (gas) — ~0.5 POL is sufficient for hundreds of transactions
- **USDC.e** (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) — trading capital

Sources: exchange withdrawal to Polygon, or bridge from Ethereum mainnet.

### 3. Set Contract Allowances

Before the first trade, approve Polymarket's contracts to spend your USDC and
Conditional Tokens. This is a one-time on-chain transaction.

**Contracts to approve** (both USDC.e and CTF tokens):
| Contract | Address |
|----------|---------|
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |

**Token addresses:**
| Token | Address |
|-------|---------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |

```python
from web3 import Web3

w3 = Web3(Web3.HTTPProvider("https://polygon-rpc.com"))
PRIVATE_KEY = "0x..."
account = w3.eth.account.from_key(PRIVATE_KEY)

ERC20_ABI = [{"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],
              "name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function"}]
ERC1155_ABI = [{"inputs":[{"name":"operator","type":"address"},{"name":"approved","type":"bool"}],
                "name":"setApprovalForAll","outputs":[],"type":"function"}]

USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
CTF  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
MAX_UINT256 = 2**256 - 1

SPENDERS = [
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",  # CTF Exchange
    "0xC5d563A36AE78145C45a50134d48A1215220f80a",  # Neg Risk Exchange
    "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",  # Neg Risk Adapter
]

usdc = w3.eth.contract(address=USDC, abi=ERC20_ABI)
ctf  = w3.eth.contract(address=CTF, abi=ERC1155_ABI)

for spender in SPENDERS:
    # Approve USDC
    tx = usdc.functions.approve(spender, MAX_UINT256).build_transaction({
        "from": account.address, "nonce": w3.eth.get_transaction_count(account.address),
        "gas": 100_000, "gasPrice": w3.eth.gas_price,
    })
    signed = account.sign_transaction(tx)
    w3.eth.send_raw_transaction(signed.raw_transaction)

    # Approve CTF (ERC1155)
    tx = ctf.functions.setApprovalForAll(spender, True).build_transaction({
        "from": account.address, "nonce": w3.eth.get_transaction_count(account.address),
        "gas": 100_000, "gasPrice": w3.eth.gas_price,
    })
    signed = account.sign_transaction(tx)
    w3.eth.send_raw_transaction(signed.raw_transaction)
```

### 4. Configure Polybot

In `.env`:
```
POLYMARKET_PRIVATE_KEY=0x<your-hex-key>
POLYMARKET_FUNDER_ADDRESS=<your-eoa-address>
POLYMARKET_SIGNATURE_TYPE=0
```

## Redemption

### Using `polymarket-apis` Package

```bash
pip install polymarket-apis
```

```python
from polymarket_apis import PolymarketGaslessWeb3Client, PolymarketDataClient

def redeem_all_positions(private_key: str):
    """Redeem all winning positions for USDC."""
    web3_client = PolymarketGaslessWeb3Client(
        private_key=private_key,
        signature_type=0,  # EOA
        chain_id=137,
    )
    data_client = PolymarketDataClient()

    # Get proxy address (where positions are held)
    proxy_address = web3_client.address
    print(f"Checking redeemable positions for {proxy_address}")

    positions = data_client.get_positions(proxy_address, redeemable=True)
    if not positions:
        print("No redeemable positions found")
        return

    for pos in positions:
        amounts = [0, 0]
        amounts[pos.outcome_index] = pos.size
        neg_risk = getattr(pos, "negative_risk", False)

        print(f"Redeeming: condition={pos.condition_id}, "
              f"outcome={pos.outcome_index}, size={pos.size}, neg_risk={neg_risk}")
        result = web3_client.redeem_position(
            condition_id=pos.condition_id,
            amounts=amounts,
            neg_risk=neg_risk,
        )
        print(f"  Result: {result}")
```

### Integration Points in Polybot

#### Option A: CLI Command

Add to `polybot/cli.py`:
```python
@cli.command()
def redeem():
    """Redeem all winning Polymarket positions."""
    from polybot.redeem import redeem_all_positions
    config = Config.from_env()
    if not config.private_key:
        click.echo("Error: POLYMARKET_PRIVATE_KEY not set")
        raise SystemExit(1)
    redeem_all_positions(config.private_key)
```

#### Option B: API Endpoint

Add to `polybot/api.py`:
```python
@app.post("/api/redeem")
async def redeem_positions():
    """Redeem all winning positions."""
    from polybot.redeem import redeem_all_positions
    config = Config.from_env()
    if not config.private_key:
        raise HTTPException(400, "POLYMARKET_PRIVATE_KEY not configured")
    results = redeem_all_positions(config.private_key)
    return {"redeemed": len(results), "results": results}
```

#### Option C: Automated (in Worker cron or listener)

After detecting a CONVERSION event in `handlePositionExit()`, trigger redemption
for the winning condition. This would require the Worker to call the Cloud Run
`/api/redeem` endpoint, similar to how it calls `/api/copy/execute`.

### Rate Limiting

The `polymarket-apis` package uses Polymarket's relayer API which has rate limits.
If you hit "quota exceeded" errors, you can provide custom builder API credentials:

```python
from py_clob_client.clob_types import ApiCreds

web3_client = PolymarketGaslessWeb3Client(
    private_key=private_key,
    signature_type=0,
    chain_id=137,
    builder_creds=ApiCreds(key="...", secret="...", passphrase="..."),
)
```

Builder creds are derived from `client.create_or_derive_api_creds()` using py-clob-client.

## Contract Addresses Reference

| Contract | Address | Purpose |
|----------|---------|---------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | Collateral token |
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | Position tokens (ERC1155) |
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | Order matching |
| Neg Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | Neg risk order matching |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | Neg risk position adapter |

## Transferring Existing Positions

If you have winning positions on your Google OAuth wallet that you want to redeem,
you have two options:

1. **Sell on the market** — List your winning shares at ~$0.99 before resolution.
   Other traders will buy them. No on-chain redemption needed.

2. **Wait for Polymarket UI** — The polymarket.com website handles redemption
   automatically through the Magic.link wallet infrastructure.

There is no way to programmatically redeem from the Google OAuth wallet without
the Magic.link private key.
