/**
 * Minimal ELAN annotation document (EAF 3.0) writer.
 *
 * One time-aligned tier per speaker, one annotation per utterance, and the
 * source audio linked in the header by file name. The browser never sees the
 * file's full path, so the link is relative ("./name.wav"): ELAN finds the
 * audio when the .eaf is saved in the same folder.
 */

const MIME_TYPES = {
  wav: 'audio/x-wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
};

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** "path/to/Act 1.wav" -> "Act 1" */
export function fileStem(fileName) {
  const base = String(fileName).split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function mimeTypeFor(fileName) {
  const ext = String(fileName).split('.').pop().toLowerCase();
  return MIME_TYPES[ext] || 'audio/*';
}

/**
 * @param {Array<{ name: string, mediaFileName: string,
 *                 segments: Array<{ start: number, end: number, text: string }> }>} tiers
 *   One entry per speaker; start/end in seconds.
 * @param {{ author?: string, date?: Date }} [opts]
 * @returns {string} EAF 3.0 XML
 */
export function buildEaf(tiers, opts = {}) {
  const date = (opts.date || new Date()).toISOString();
  const media = [...new Set(tiers.map(t => t.mediaFileName).filter(Boolean))];

  const timeSlots = [];
  let annotationCount = 0;
  const tierXml = tiers.map(tier => {
    const annotations = tier.segments
      .filter(sg => Number.isFinite(sg.start) && Number.isFinite(sg.end) && String(sg.text).trim())
      .map(sg => {
        const startMs = Math.max(0, Math.round(sg.start * 1000));
        // ELAN needs end > start.
        const endMs = Math.max(startMs + 1, Math.round(sg.end * 1000));
        const ts1 = `ts${timeSlots.push(startMs)}`;
        const ts2 = `ts${timeSlots.push(endMs)}`;
        annotationCount += 1;
        return `        <ANNOTATION>
            <ALIGNABLE_ANNOTATION ANNOTATION_ID="a${annotationCount}" TIME_SLOT_REF1="${ts1}" TIME_SLOT_REF2="${ts2}">
                <ANNOTATION_VALUE>${escapeXml(String(sg.text).trim())}</ANNOTATION_VALUE>
            </ALIGNABLE_ANNOTATION>
        </ANNOTATION>`;
      });
    const body = annotations.length ? `\n${annotations.join('\n')}\n    ` : '';
    return `    <TIER LINGUISTIC_TYPE_REF="utterance" TIER_ID="${escapeXml(tier.name)}">${body}</TIER>`;
  });

  const mediaXml = media
    .map(name => `        <MEDIA_DESCRIPTOR MEDIA_URL="file:///${escapeXml(encodeURI(name))}" MIME_TYPE="${mimeTypeFor(name)}" RELATIVE_MEDIA_URL="./${escapeXml(encodeURI(name))}"/>`)
    .join('\n');
  const slotXml = timeSlots
    .map((ms, i) => `        <TIME_SLOT TIME_SLOT_ID="ts${i + 1}" TIME_VALUE="${ms}"/>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="${escapeXml(opts.author || '')}" DATE="${date}" FORMAT="3.0" VERSION="3.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">
    <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds">
${mediaXml}
        <PROPERTY NAME="lastUsedAnnotationId">${annotationCount}</PROPERTY>
    </HEADER>
    <TIME_ORDER>
${slotXml}
    </TIME_ORDER>
${tierXml.join('\n')}
    <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="utterance" TIME_ALIGNABLE="true"/>
    <CONSTRAINT DESCRIPTION="Time subdivision of parent annotation's time interval, no time gaps allowed within this interval" STEREOTYPE="Time_Subdivision"/>
    <CONSTRAINT DESCRIPTION="Symbolic subdivision of a parent annotation. Annotations refering to the same parent are ordered" STEREOTYPE="Symbolic_Subdivision"/>
    <CONSTRAINT DESCRIPTION="1-1 association with a parent annotation" STEREOTYPE="Symbolic_Association"/>
    <CONSTRAINT DESCRIPTION="Time alignable annotations within the parent annotation's time interval, gaps are allowed" STEREOTYPE="Included_In"/>
</ANNOTATION_DOCUMENT>
`;
}

/** Trigger a browser download of `text` as `fileName`. */
export function downloadText(text, fileName, mimeType = 'application/xml') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
