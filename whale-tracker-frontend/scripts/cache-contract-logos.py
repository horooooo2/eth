"""Download bounded, validated icon assets at development time (never at server startup)."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'contract-logos'
MANIFEST = ROOT / 'src' / 'utils' / 'contractLogoAssets.json'
domains = sorted(set(re.findall(r":'([a-z0-9.-]+\.[a-z]+)'", (ROOT / 'src/utils/contractLogo.ts').read_text(encoding='utf-8'))))
jobs = [(domain, f'https://icons.duckduckgo.com/ip3/{domain}.ico', f'{domain}.ico') for domain in domains]
jobs += [(f'crypto:{coin}', f'https://www.okx.com/cdn/oksupport/asset/currency/icon/{coin.lower()}.png', f'crypto-{coin}.png') for coin in ['BTC','ETH','SOL','DOGE','XRP','BNB']]

def download(job):
    key, url, name = job
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'WhaleTracker icon asset maintenance'})
        with urllib.request.urlopen(request, timeout=12) as response:
            content = response.read(512 * 1024 + 1)
        if len(content) > 512 * 1024 or not content.startswith((b'\x00\x00\x01\x00', b'\x89PNG\r\n\x1a\n', b'GIF8', b'\xff\xd8\xff')):
            raise ValueError('Not a supported bounded raster image')
        (OUT / name).write_bytes(content)
        return key, f'/contract-logos/{name}'
    except Exception as error:
        print(f'Skipped {key}: {type(error).__name__}', flush=True)
        return None

if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    with ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(download, jobs):
            if result:
                manifest[result[0]] = result[1]
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Bundled {len(manifest)} validated icons; attempted {len(jobs)} sources.')
