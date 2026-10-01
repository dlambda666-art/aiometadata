const { httpGet } = require("./httpClient");
const { cacheWrapMetaSmart } = require("../lib/getCache");
const { getMeta } = require("../lib/getMeta");
const Utils = require("./parseProps");
const idMapper = require("../lib/id-mapper");
const imdb = require("../lib/imdb");
const { getImdbRating } = require("../lib/getImdbRating");
const { resolveAllIds } = require('../lib/id-resolver');
const consola = require('consola');
const buildInfo = require('../lib/buildInfo');

const logger = consola.withTag('StremThru');

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

async function _makeRequest(url) {
  try {
    const response = await httpGet(url, { headers: { 'User-Agent': `AIOMetadata/${buildInfo.version}` }, timeout: 30000 });
    return response.data;
  } catch (err) {
    if (err.response) {
      const { status, data } = err.response;
      logger.error(`HTTP error from ${url} (status: ${status}): ${typeof data === 'string' ? data.slice(0,100) : ''}`);
    } else {
      logger.error(`Request to ${url} failed:`, err.message);
    }
    throw err;
  }
}

async function _processAnimeItem(item, provider, id, language, config, includeVideos = false) {
  const mappingFunctions = {
    kitsu: idMapper.getMappingByKitsuId,
    mal: idMapper.getMappingByMalId,
    anidb: idMapper.getMappingByAnidbId,
    anilist: idMapper.getMappingByAnilistId,
  };
  const getMapping = mappingFunctions[provider];
  const mapping = getMapping ? getMapping(id) : null;
  if (!mapping) {
    logger.info(`No mapping found for anime ${provider}:${id}`);
    return null;
  }
  const malId = mapping.mal_id;
  const isMovie = item.type === 'movie';
  const imdbId = isMovie ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.imdb : mapping.imdb_id;
  if(config.mal?.useImdbIdForCatalogAndSearch && item.type === 'series' && imdbId){
    return (await cacheWrapMetaSmart(config.userUUID, imdbId, async () => {
      return await getMeta(item.type, language, imdbId, config, config.userUUID, includeVideos);
    }, undefined, { enableErrorCaching: true, maxRetries: 2, config }, item.type, includeVideos))?.meta || null;
  } else if(!config.mal?.useImdbIdForCatalogAndSearch || !imdbId){
    const posterUrl = mapping.mal_id
      ? await Utils.getAnimePoster({ malId: mapping.mal_id, imdbId: imdbId, malPosterUrl: item.poster, mediaType: item.type }, config)
      : item.poster;
    let posterProxyUrl;
    if(imdbId && Utils.isPosterRatingEnabled(config)){
      posterProxyUrl = Utils.buildPosterProxyUrl(host, item.type, imdbId, posterUrl, language, config);
    }else{
      posterProxyUrl = posterUrl;
    }
    const details = await imdb.getMetaFromImdb(imdbId, item.type);
    return {
      id: item.id,
      type: item.type,
      cast: details?.cast || [],
      name: item.name,
      poster: posterProxyUrl,
      releaseInfo: details?.releaseInfo || item.releaseInfo,
      background: details?.background || item.background,
      logo: details?.logo,
      description: Utils.addMetaProviderAttribution(item.description || details?.description, provider, config),
      imdbRating: details?.imdbRating || item.imdbRating,
      genres: item.genres || [],
      runtime: details?.runtime,
      year: item.releaseInfo,
      trailers: item.trailers || details?.trailers || [],
      behavioralHints: details?.behavioralHints || item.behavioralHints,
    };
  }
}

/**
 * External addons already return Stremio metas. Re-resolving every item through
 * AIOMeta's metadata providers can drop or rewrite valid upstream entries,
 * especially future releases whose metadata provider has no released record yet.
 * Keep the upstream meta intact by default; enrichment remains available through
 * the explicit legacy flag for instances that need it.
 */
async function _processStandardItem(item, provider, language, config, includeVideos = false) {
  if (config?.preserveExternalCatalogMetas !== false) {
    const meta = { ...item };
    if (meta.type == null) meta.type = item.type;
    if (meta.id == null) meta.id = item.id;
    if (meta.name == null) meta.name = item.name || 'Unknown';
    if (meta.poster == null && item.poster) meta.poster = item.poster;
    if (meta.genres == null && Array.isArray(item.genres)) meta.genres = item.genres;
    if (meta.releaseInfo == null && item.releaseInfo != null) meta.releaseInfo = item.releaseInfo;
    if (meta.year == null && item.year != null) meta.year = item.year;
    return meta;
  }

  let stremioId = item.id;
  const result = await cacheWrapMetaSmart(config.userUUID, item.id, async () => {
    return await getMeta(item.type, language, stremioId, config, config.userUUID, includeVideos);
  }, undefined, { enableErrorCaching: true, maxRetries: 2, config }, item.type, includeVideos);
  if (result?.meta && item.behaviorHints && Object.keys(item.behaviorHints).length > 0) {
    result.meta.behaviorHints = item.behaviorHints;
  }
  return result?.meta || null;
}

function _createFallbackMeta(item, language, config) {
  const fallbackPosterUrl = item.poster || `${host}/missing_poster.png`;
  const posterProxyUrl = Utils.isPosterRatingEnabled(config)
    ? `${host}/poster/${item.type}/${item.id}?fallback=${encodeURIComponent(fallbackPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`
    : fallbackPosterUrl;
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: posterProxyUrl,
    description: item.description || '',
    genres: item.genres || [],
    year: item.releaseInfo || null,
    releaseInfo: item.releaseInfo || null,
    imdbRating: item.imdbRating || null,
  };
}

async function fetchStremThruCatalog(catalogUrl, skip = 0, genre) {
  try {
    let url = catalogUrl;
    const params = [];
    if (skip > 0) params.push(`skip=${skip}`);
    if (genre && genre.toLowerCase() !== 'none') params.push(`genre=${encodeURIComponent(genre)}`);
    if (params.length > 0) {
      url = url.replace(/\.json$/, '');
      url = `${url}/${params.join('&')}.json`;
    }
    const data = await _makeRequest(url);
    if (!data || !data.metas) {
      logger.warn(`Invalid response format from ${catalogUrl}`);
      return [];
    }
    logger.debug(`Successfully fetched ${data.metas.length} items from catalog (skip: ${skip}, genre: ${genre || 'all'})`);
    return data.metas;
  } catch (err) {
    return [];
  }
}

async function fetchStremThruManifest(manifestUrl) {
  try {
    const data = await _makeRequest(manifestUrl);
    if (!data || !data.catalogs) {
      logger.warn(`Invalid manifest format from ${manifestUrl}`);
      return [];
    }
    logger.debug(`Successfully fetched ${data.catalogs.length} catalogs from manifest`);
    return data.catalogs;
  } catch (err) {
    return [];
  }
}

async function getGenresFromStremThruCatalog(items) {
  try {
    const genres = [
      ...new Set(
        items.flatMap(item =>
          (item.genres || []).map(g =>
            (g && typeof g === "string") ? g.charAt(0).toUpperCase() + g.slice(1).toLowerCase() : null
          )
        ).filter(Boolean)
      )
    ].sort();
    logger.debug(`Extracted ${genres.length} unique genres from catalog`);
    return genres;
  } catch (err) {
    logger.error("ERROR in getGenresFromStremThruCatalog:", err);
    return [];
  }
}

async function parseStremThruItems(items, type, genreFilter, language, config, includeVideos = false) {
  const animeProviders = new Set(['mal', 'kitsu', 'anidb', 'anilist']);
  logger.debug(`Processing ${items.length} items (type: ${type}, genre: ${genreFilter || 'all'})`);
  const metaPromises = items.map(async item => {
    try {
      let provider, id;
      if (item.id.startsWith('tun_')) {
        provider = 'imdb';
        id = item.id.replace(/^tun_/, '');
      } else if (item.id.startsWith('tt')) {
        provider = 'imdb';
        id = item.id;
      } else {
        [provider, id] = item.id.split(':');
      }
      if (!provider || !id) {
        logger.warn(`Invalid ID format: ${item.id}`);
        return _createFallbackMeta(item, language, config);
      }
      let meta;
      if (animeProviders.has(provider)) {
        meta = await _processAnimeItem(item, provider, id, language, config, includeVideos);
      } else {
        meta = await _processStandardItem(item, provider, language, config, includeVideos);
      }
      return meta || _createFallbackMeta(item, language, config);
    } catch (error) {
      logger.error(`Error processing item ${item.id}:`, error.message);
      return _createFallbackMeta(item, language, config);
    }
  });
  const metas = await Promise.all(metaPromises);
  const validMetas = metas.filter(Boolean);
  logger.debug(`Successfully parsed ${validMetas.length}/${items.length} items`);
  return validMetas;
}

module.exports = {
  fetchStremThruCatalog,
  fetchStremThruManifest,
  getGenresFromStremThruCatalog,
  parseStremThruItems
};
