#!/usr/bin/env python3
"""
credit_analyzer.py - Private credit BDC 10-Q/10-K search

BDC identification strategy:
  SEC EDGAR assigns Investment Company Act file numbers starting with "814-"
  to Business Development Companies. This is present in every EFTS search
  result and is authoritative — no hard-coded CIK lists needed.

Commands:
  search <issuer> [max_per_fund]   EFTS search filtered to 814- filers,
                                   plus complete 10-Q history per fund.
  docurl <accession>               Return primary document URL.
"""

import sys, json, os, re, requests
from edgar import Company, set_identity, get_by_accession_number

IDENTITY = os.environ.get('SEC_USER_AGENT', 'NPORT-Analyzer internal-tool@localhost')
HEADERS  = {'User-Agent': IDENTITY, 'Accept': 'application/json'}


# ── helpers ──────────────────────────────────────────────────────────────────

def clean_name(raw):
    """Strip trailing ticker/CIK parentheticals from display names."""
    name = re.sub(r'\s*\([^)]*\)\s*$', '', str(raw)).strip()
    return name or raw


def is_bdc(file_nums):
    """True if any file number is an Investment Company Act 814- number."""
    return any(str(fn).startswith('814-') for fn in (file_nums or []))


# ── search ───────────────────────────────────────────────────────────────────

def search(issuer, max_per_fund=None):
    set_identity(IDENTITY)

    # ── Step 1: EFTS full-text search ──────────────────────────────────────
    resp = requests.get(
        'https://efts.sec.gov/LATEST/search-index',
        params={'q': f'"{issuer}"', 'forms': '10-Q', 'from': 0, 'size': 200},
        headers=HEADERS, timeout=30,
    )
    resp.raise_for_status()
    hits = resp.json().get('hits', {}).get('hits', [])

    # ── Step 2: Filter to BDC filers (814- file number) ────────────────────
    confirmed    = []
    bdc_cik_name = {}   # { "1422183": "FS KKR Capital Corp" }

    for hit in hits:
        src       = hit['_source']
        file_nums = src.get('file_num', [])
        if not is_bdc(file_nums):
            continue

        ciks = src.get('ciks', [])
        cik  = str(ciks[0]).lstrip('0') if ciks else ''
        name = clean_name(src.get('display_names', ['Unknown'])[0])
        if cik:
            bdc_cik_name[cik] = name

        confirmed.append({
            'cik':       str(ciks[0]) if ciks else cik,
            'accession': src.get('adsh', ''),
            'company':   name,
            'period':    src.get('period_ending', '') or src.get('file_date', ''),
            'fileDate':  src.get('file_date', ''),
            'confirmed': True,
        })

    confirmed_accessions = {f['accession'] for f in confirmed}

    # ── Step 3: Complete 10-Q history for each identified BDC ──────────────
    # This closes gaps where EFTS may not surface every quarter for older filings.
    historical = []
    for cik, name in bdc_cik_name.items():
        try:
            co      = Company(cik)
            filings = co.get_filings(form='10-Q')
            if not filings:
                continue
            count = 0
            for f in filings:
                if max_per_fund and count >= max_per_fund:
                    break
                acc = str(f.accession_no or '')
                if not acc or acc in confirmed_accessions:
                    count += 1
                    continue
                historical.append({
                    'cik':       str(f.cik or cik),
                    'accession': acc,
                    'company':   name,
                    'period':    str(f.period_of_report or ''),
                    'fileDate':  str(f.filing_date or ''),
                    'confirmed': False,
                })
                count += 1
        except Exception:
            pass

    # Confirmed first (newest → oldest), then historical (newest → oldest)
    def by_period(f):
        return f.get('period', '') or f.get('fileDate', '')

    confirmed.sort(key=by_period, reverse=True)
    historical.sort(key=by_period, reverse=True)
    result = confirmed + historical

    print(json.dumps({
        'filings':   result,
        'bdcFunds':  sorted(set(bdc_cik_name.values())),
        'confirmed': len(confirmed),
        'total':     len(result),
    }))


# ── docurl ───────────────────────────────────────────────────────────────────

def docurl(accession):
    set_identity(IDENTITY)
    filing = get_by_accession_number(accession)
    if not filing or not filing.document:
        print(json.dumps({'error': 'Filing or document not found'}))
        return
    print(json.dumps({'url': filing.document.url}))


# ── entry point ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No command given'}))
        sys.exit(1)

    cmd = sys.argv[1]
    try:
        if cmd == 'search':
            issuer       = sys.argv[2] if len(sys.argv) > 2 else ''
            max_per_fund = int(sys.argv[3]) if len(sys.argv) > 3 else None
            if not issuer:
                print(json.dumps({'error': 'issuer argument required'}))
                sys.exit(1)
            search(issuer, max_per_fund)

        elif cmd == 'docurl':
            accession = sys.argv[2] if len(sys.argv) > 2 else ''
            if not accession:
                print(json.dumps({'error': 'accession argument required'}))
                sys.exit(1)
            docurl(accession)

        else:
            print(json.dumps({'error': f'Unknown command: {cmd}'}))
            sys.exit(1)

    except Exception as e:
        import traceback
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}))
        sys.exit(1)
