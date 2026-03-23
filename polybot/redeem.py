"""Polymarket position redemption via direct on-chain calls (EOA wallet).

Redeems winning conditional token positions back to USDC.e after market resolution.
Sends transactions directly on Polygon — requires POL for gas.

Requires env vars:
  - POLYMARKET_PRIVATE_KEY
  - POLYMARKET_FUNDER_ADDRESS
"""

from __future__ import annotations

import logging
import os
import time

import requests
from eth_abi import encode as eth_encode
from eth_account import Account
from eth_utils import keccak
from web3 import Web3

logger = logging.getLogger(__name__)

# Contract addresses (Polygon mainnet)
CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"
USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
ZERO_BYTES32 = b"\x00" * 32
POLYGON_RPC = "https://polygon-bor.publicnode.com"


def _selector(sig: str) -> bytes:
    return keccak(text=sig)[:4]


def _build_ctf_redeem_data(condition_id: str) -> bytes:
    """Encode redeemPositions(address,bytes32,bytes32,uint256[]) for CTF."""
    sel = _selector("redeemPositions(address,bytes32,bytes32,uint256[])")
    cid_bytes = bytes.fromhex(condition_id[2:] if condition_id.startswith("0x") else condition_id)
    args = eth_encode(
        ["address", "bytes32", "bytes32", "uint256[]"],
        [USDC_POLYGON, ZERO_BYTES32, cid_bytes, [1, 2]],
    )
    return sel + args


def _build_neg_risk_redeem_data(condition_id: str, amounts: list[int]) -> bytes:
    """Encode redeemPositions(bytes32,uint256[]) for NegRiskAdapter."""
    sel = _selector("redeemPositions(bytes32,uint256[])")
    cid_bytes = bytes.fromhex(condition_id[2:] if condition_id.startswith("0x") else condition_id)
    args = eth_encode(["bytes32", "uint256[]"], [cid_bytes, amounts])
    return sel + args


def _get_web3() -> Web3:
    w3 = Web3(Web3.HTTPProvider(POLYGON_RPC))
    if not w3.is_connected():
        raise RuntimeError(f"Cannot connect to Polygon RPC: {POLYGON_RPC}")
    return w3


DATA_API = "https://data-api.polymarket.com"


def _fetch_positions(address: str) -> list[dict]:
    """Fetch positions from the Polymarket Data API."""
    resp = requests.get(f"{DATA_API}/positions", params={"user": address}, timeout=15)
    resp.raise_for_status()
    return resp.json()


def get_redeemable_positions(
    private_key: str = "",
    signature_type: int = 0,
    funder_address: str | None = None,
) -> list[dict]:
    """Fetch all redeemable positions for the configured wallet."""
    address = funder_address or os.environ.get("POLYMARKET_FUNDER_ADDRESS", "")
    if not address:
        raise RuntimeError("No funder_address or POLYMARKET_FUNDER_ADDRESS set")
    positions = _fetch_positions(address)
    redeemable = [p for p in positions if p.get("redeemable")]
    logger.info("Found %d redeemable positions (%d total) for %s", len(redeemable), len(positions), address)
    return redeemable


def redeem_all(
    private_key: str = "",
    signature_type: int = 0,
    funder_address: str | None = None,
) -> list[dict]:
    """Redeem all winning positions via direct on-chain transactions.

    Sends one transaction per condition ID to the CTF or NegRiskAdapter contract.
    """
    pk = private_key or os.environ.get("POLYMARKET_PRIVATE_KEY", "")
    address = funder_address or os.environ.get("POLYMARKET_FUNDER_ADDRESS", "")
    if not pk or not address:
        raise RuntimeError("Need POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS")

    all_positions = _fetch_positions(address)
    positions = [p for p in all_positions if p.get("redeemable")]
    if not positions:
        logger.info("No redeemable positions for %s (%d total)", address, len(all_positions))
        return []

    conditions: dict[str, list[dict]] = {}
    for pos in positions:
        cid = pos.get("conditionId")
        if cid:
            conditions.setdefault(cid, []).append(pos)

    logger.info("Redeeming %d conditions for %s", len(conditions), address)
    return _redeem_onchain(pk, address, conditions)


def redeem_conditions(
    private_key: str = "",
    condition_ids: list[str] | None = None,
    signature_type: int = 0,
    funder_address: str | None = None,
) -> list[dict]:
    """Redeem specific condition IDs via direct on-chain transactions."""
    if not condition_ids:
        return []

    pk = private_key or os.environ.get("POLYMARKET_PRIVATE_KEY", "")
    address = funder_address or os.environ.get("POLYMARKET_FUNDER_ADDRESS", "")
    if not pk or not address:
        raise RuntimeError("Need POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS")

    all_positions = _fetch_positions(address)
    conditions: dict[str, list[dict]] = {}
    for pos in all_positions:
        cid = pos.get("conditionId")
        if cid and cid in condition_ids and pos.get("redeemable"):
            conditions.setdefault(cid, []).append(pos)

    if not conditions:
        logger.info("No redeemable positions found for %d condition IDs (%d total positions)", len(condition_ids), len(all_positions))
    return _redeem_onchain(pk, address, conditions)


def _redeem_onchain(
    private_key: str,
    address: str,
    conditions: dict[str, list[dict]],
) -> list[dict]:
    """Send one on-chain transaction per condition to redeem positions."""
    w3 = _get_web3()
    account = Account.from_key(private_key)
    nonce = w3.eth.get_transaction_count(account.address)
    results: list[dict] = []

    for cid, positions in conditions.items():
        is_neg_risk = any(p.get("negativeRisk") for p in positions)

        if is_neg_risk:
            amounts = [0.0, 0.0]
            for p in positions:
                idx = p.get("outcomeIndex", 0)
                if idx in (0, 1):
                    amounts[idx] += float(p.get("size", 0))
            int_amounts = [int(a * 1e6) for a in amounts]
            calldata = _build_neg_risk_redeem_data(cid, int_amounts)
            target = NEG_RISK_ADAPTER
        else:
            calldata = _build_ctf_redeem_data(cid)
            target = CTF_ADDRESS

        try:
            target_cs = Web3.to_checksum_address(target)
            gas_price = w3.eth.gas_price
            # Add 20% buffer to gas price for faster confirmation
            gas_price = int(gas_price * 1.2)

            tx = {
                "to": target_cs,
                "from": account.address,
                "data": calldata,
                "value": 0,
                "nonce": nonce,
                "gasPrice": gas_price,
                "chainId": 137,
            }
            # Estimate gas with buffer
            gas_estimate = w3.eth.estimate_gas(tx)
            tx["gas"] = int(gas_estimate * 1.3)

            signed = account.sign_transaction(tx)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            logger.info("Sent redeem tx for %s: %s (nonce=%d)", cid[:16], tx_hash.hex()[:16], nonce)

            # Wait for receipt (up to 60s)
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
            if receipt["status"] == 1:
                results.append({
                    "condition_id": cid,
                    "status": "redeemed",
                    "tx_hash": tx_hash.hex(),
                })
                logger.info("Redeemed %s: tx=%s gas=%d", cid[:16], tx_hash.hex()[:16], receipt["gasUsed"])
            else:
                results.append({
                    "condition_id": cid,
                    "status": "reverted",
                    "tx_hash": tx_hash.hex(),
                })
                logger.error("Reverted %s: tx=%s", cid[:16], tx_hash.hex()[:16])

            nonce += 1
            # Small delay between transactions to avoid RPC rate limiting
            time.sleep(1)

        except Exception as e:
            logger.error("Redeem failed for %s: %s", cid[:16], e)
            results.append({
                "condition_id": cid,
                "status": "error",
                "detail": str(e),
            })
            # Re-fetch nonce from chain — a timed-out tx may have confirmed,
            # advancing the on-chain nonce past our local counter.
            try:
                nonce = w3.eth.get_transaction_count(account.address)
            except Exception:
                pass

    return results


def _build_ctf_merge_data(condition_id: str, amount: int) -> bytes:
    """Encode mergePositions(address,bytes32,bytes32,uint256[],uint256) for CTF."""
    sel = _selector("mergePositions(address,bytes32,bytes32,uint256[],uint256)")
    cid_bytes = bytes.fromhex(condition_id[2:] if condition_id.startswith("0x") else condition_id)
    args = eth_encode(
        ["address", "bytes32", "bytes32", "uint256[]", "uint256"],
        [USDC_POLYGON, ZERO_BYTES32, cid_bytes, [1, 2], amount],
    )
    return sel + args


def merge_positions(
    condition_id: str,
    amount: float,
    private_key: str = "",
    funder_address: str | None = None,
) -> dict:
    """Merge matched YES+NO tokens back to USDC via CTF contract.

    Returns {status, tx_hash, gas_used, duration_ms}.
    """
    pk = private_key or os.environ.get("POLYMARKET_PRIVATE_KEY", "")
    address = funder_address or os.environ.get("POLYMARKET_FUNDER_ADDRESS", "")
    if not pk or not address:
        return {"status": "failed", "error": "Missing POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER_ADDRESS"}

    # amount in token units → raw (×1e6 for USDC decimals)
    int_amount = int(amount * 1e6)
    if int_amount <= 0:
        return {"status": "failed", "error": f"Invalid amount: {amount}"}

    w3 = _get_web3()
    account = Account.from_key(pk)
    calldata = _build_ctf_merge_data(condition_id, int_amount)
    target_cs = Web3.to_checksum_address(CTF_ADDRESS)

    start = time.time()
    try:
        nonce = w3.eth.get_transaction_count(account.address)
        gas_price = int(w3.eth.gas_price * 1.2)

        tx = {
            "to": target_cs,
            "from": account.address,
            "data": calldata,
            "value": 0,
            "nonce": nonce,
            "gasPrice": gas_price,
            "chainId": 137,
        }
        gas_estimate = w3.eth.estimate_gas(tx)
        tx["gas"] = int(gas_estimate * 1.3)

        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        logger.info("Sent merge tx for %s: %s (amount=%s)", condition_id[:16], tx_hash.hex()[:16], amount)

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
        duration_ms = int((time.time() - start) * 1000)

        if receipt["status"] == 1:
            logger.info("Merged %s: tx=%s gas=%d %dms", condition_id[:16], tx_hash.hex()[:16], receipt["gasUsed"], duration_ms)
            return {
                "status": "merged",
                "tx_hash": tx_hash.hex(),
                "gas_used": receipt["gasUsed"],
                "duration_ms": duration_ms,
            }
        else:
            logger.error("Merge reverted %s: tx=%s", condition_id[:16], tx_hash.hex()[:16])
            return {
                "status": "failed",
                "tx_hash": tx_hash.hex(),
                "error": "transaction reverted",
                "duration_ms": duration_ms,
            }
    except Exception as e:
        duration_ms = int((time.time() - start) * 1000)
        logger.error("Merge failed for %s: %s", condition_id[:16], e)
        return {
            "status": "failed",
            "error": str(e),
            "duration_ms": duration_ms,
        }
