# Builds public/index.html from the app source. Run: python3 build_app.py [path-to-app.html]
import sys, os
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'deadline-stickers.html')
s = open(src, encoding='utf-8').read()
head = ('<link rel="manifest" href="manifest.webmanifest">\n<meta name="theme-color" content="#B9A6FF">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="ClassFeed">\n')
assert s.count('</head>') == 1
s = s.replace('</head>', head + '</head>')
cfg = "<script>window.APP_CONFIG = { feed: true, aiEndpoint: '/api/ai' };</script>\n"
i = s.rindex('<script>')
s = s[:i] + cfg + s[i:]
reg = "if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); }); }\n"
j = s.rindex('</script>')
s = s[:j] + reg + s[j:]
open(os.path.join(os.path.dirname(__file__), 'public', 'index.html'), 'w', encoding='utf-8').write(s)
print('built public/index.html', len(s))
