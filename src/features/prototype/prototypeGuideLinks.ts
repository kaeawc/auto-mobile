export const GUIDE_INBOUND_LINKS = `## Inbound links (contract only)

Root \`links\` declares up to 32 ordered inbound routes and requires
\`requires:["prototype_links_v1"]\`. Each entry has \`path\`, optional \`query\` scalar declarations
(string, int, number or boolean; append ? for optional), and 1–32 \`actions\`.
Use \`{link:"name"}\` in actions to read a path capture or declared query value.
Query metadata \`{type:"string?",secret:true}\` marks values for removal from event URLs.
Captures must be used; duplicate patterns, unknown names and route type mismatches are rejected.
The first matching route wins. Registration checks schemes case-insensitively; web URLs need
both a registered scheme and host. Core events are \`link_opened {url,entry}\` and
\`link_unmatched {url}\`; unmatched URLs run no actions. Native runtime delivery is deferred.
Inbound navigation does not require \`prototype_platform_v1\` and is separate from \`links.open\`.`;
