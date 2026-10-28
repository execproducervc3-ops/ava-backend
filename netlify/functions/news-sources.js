// Regional (Caribbean-wide) news feeds. The sourceTag values are stored in knowledge_articles.source and are
// how AVA tells regional stories apart from local SVG ones. Tags use only letters and hyphens on purpose.
// To add or retire a feed, change it here: both the ingest function and AVA's news search read this list.
const REGIONAL_FEEDS = [
  { url: 'https://thecaribbeannewsnow.com/feed/', sourceTag: 'rss-regional-caribbeannewsnow' },
  { url: 'https://www.cananewsonline.com/main/feed/', sourceTag: 'rss-regional-cana' },
  { url: 'https://www.wicnews.com/feed', sourceTag: 'rss-regional-wicnews' },
  { url: 'https://www.associatestimes.com/feed', sourceTag: 'rss-regional-associatestimes' },
  { url: 'https://caribbeannewsglobal.com/feed/', sourceTag: 'rss-regional-caribbeannewsglobal' },
  { url: 'https://caribjournal.com/feed/', sourceTag: 'rss-regional-caribjournal' },
];
const REGIONAL_TAGS = REGIONAL_FEEDS.map(f => f.sourceTag);
module.exports = { REGIONAL_FEEDS, REGIONAL_TAGS };
