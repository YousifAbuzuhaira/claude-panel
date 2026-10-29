// The games list: links carry the token along in the hash (api.js also keeps it for this tab).
import { withToken } from '../shared/api.js';

for (const link of document.querySelectorAll('a.game')) link.href = withToken(link.getAttribute('href'));
