#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as Cheerio from 'cheerio';
import FormData from 'form-data';
import { readFileSync } from 'fs';
import * as _ from 'lodash-es';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const NHentaiApi = require('nhentai-api');

interface SaucenaoSearchParams {
	imageUrl?: string;
	imageBuffer?: string;
	db?: keyof typeof snDB;
}

const SAUCENAO_API_KEY = process.env.SAUCENAO_API_KEY;
const SAUCENAO_HOST = process.env.SAUCENAO_HOST || 'saucenao.com';

if (!SAUCENAO_API_KEY) {
	console.error('SAUCENAO_API_KEY environment variable is required');
	process.exit(1);
}

const snDB = {
	all: 999,
	pixiv: 5,
	danbooru: 9,
	book: 18,
	doujin: 18,
	anime: 21,
	原图: 10000,
};

interface MsgImage {
	isUrlValid: boolean;
	url?: string;
	getPath: () => Promise<string | undefined>;
}

/**
 * 取得搜图结果
 *
 * @param {string} host 自定义 saucenao 的 host
 * @param {string} api_key saucenao api key
 * @param {MsgImage} img 欲搜索的图片
 * @param {number} [db=999] 搜索库
 * @returns Promise<any>
 */
async function getSearchResult(host: string, api_key: string, img: MsgImage, db: number = 999): Promise<any> {
	if (!/^https?:\/\//.test(host)) host = `https://${host}`;

	const dbParam: { db?: number; dbs?: number[] } = {};
	switch (db) {
		case snDB.doujin:
			dbParam.dbs = [18, 38];
			break;
		case snDB.anime:
			dbParam.dbs = [21, 22];
			break;
		default:
			dbParam.db = db;
			break;
	}

	const url = `${host}/search.php`;
	const params = {
		...(api_key ? { api_key } : {}),
		...dbParam,
		output_type: 2,
		numres: 3,
		// hide: global.config.bot.hideImgWhenSaucenaoNSFW, // TODO: Make configurable via env var or tool param
	};

	// Simplified image handling for MCP: prefer URL if available, otherwise expect base64
	if (img.isUrlValid && img.url) {
		return axios.get(url, {
			params: {
				...params,
				url: img.url,
			},
		});
	} else {
		const path = await img.getPath();
		if (path) {
			const form = new FormData();
			form.append('file', readFileSync(path), 'image');
			return axios.post(url, form, {
				params,
				headers: form.getHeaders(),
			});
		}
	}

	throw new McpError(ErrorCode.InvalidParams, 'Invalid image input: URL or local path required.');
}

let ascii2dHostsI = 0;

const ASCII2D_HOSTS = process.env.ASCII2D_HOSTS ? process.env.ASCII2D_HOSTS.split(',') : ['https://ascii2d.net'];

/**
 * ascii2d 搜索
 *
 * @param {MsgImage} img 图片
 * @returns 色合検索 和 特徴検索 结果
 */
async function doAscii2dSearch(img: MsgImage) {
  const hosts = ASCII2D_HOSTS;
  let host = hosts[ascii2dHostsI++ % hosts.length];
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;

  // Skipping Puppeteer implementation for now
  const callApi = callAscii2dApi; // Assuming non-Puppeteer API call

  const ret = await callApi(host, img); // Simplified retry logic for MCP
  const colorURL = ret.request.res.responseUrl;
  if (!colorURL.includes('/color/')) {
    // Simplified error handling for MCP
    throw new McpError(ErrorCode.InternalError, 'ascii2d search failed to return color URL.');
  }
  const colorDetail = getAscii2dDetail(ret, host);

  const bovwURL = colorURL.replace('/color/', '/bovw/');
  const bovwDetail = await axios.get(bovwURL).then(r => getAscii2dDetail(r, host)); // Using axios directly

  const isCf = host === 'https://ascii2d.net';
  const colorRet = await getAscii2dResult(colorDetail, isCf);
  const bovwRet = await getAscii2dResult(bovwDetail, isCf);

  return {
    color: `ascii2d 色合検索\n${colorRet.result}`,
    bovw: `ascii2d 特徴検索\n${bovwRet.result}`,
    success: colorRet.success && bovwRet.success,
  };
}

/**
 * @param {MsgImage} img
 */
async function callAscii2dApi(host: string, img: MsgImage) {
  const isCf = host === 'https://ascii2d.net';

  // Simplified image handling for MCP: prefer URL if available, otherwise expect base64
  if (img.isUrlValid && img.url) {
    return axios.get(`${host}/search/url/${img.url}`);
  } else {
    const path = await img.getPath();
    if (path) {
      const form = new FormData();
      form.append('file', readFileSync(path), 'image');
      return axios.post(`${host}/search/file`, form, { headers: form.getHeaders() });
    }
  }

  throw new McpError(ErrorCode.InvalidParams, 'Invalid image input for ascii2d: URL or local path required.');
}

/**
 * 解析 ascii2d 网页结果
 *
 * @param {any} ret ascii2d response
 * @param {string} baseURL ascii2d base URL
 * @returns 画像搜索结果
 */
function getAscii2dDetail(ret: any, baseURL: string) {
  let result: any = {};
  const html = ret.data;
  const $ = Cheerio.load(html, { decodeEntities: false });
  const $itemBox = $('.item-box');
  for (let i = 0; i < $itemBox.length; i++) {
    const $box = $($itemBox[i]);
    const $link = $box.find('.detail-box a');
    // 普通结果
    if ($link.length) {
      const $title = $($link[0]);
      const $author = $($link[1]);
      result = {
        thumbnail: baseURL + $box.find('.image-box img').attr('src'),
        title: $title.text(),
        author: $author.text(),
        url: $title.attr('href'),
        author_url: $author.attr('href'),
      };
      break;
    }
    // 人为提交结果
    const $external = $box.find('.external');
    if ($external.length) {
      result = {
        thumbnail: baseURL + $box.find('.image-box img').attr('src'),
        title: $external.text(),
      };
      break;
    }
  }
  if (!result.title) {
    console.error('[error] ascii2d getDetail');
    console.error(ret);
  }
  return result;
}

async function getAscii2dResult({ url, title, author, thumbnail, author_url }: any, isCf = true) {
  if (!title) return { success: false, result: '由未知错误导致搜索失败' };
  const texts = [author ? `「${title}」/「${author}」` : title];
  if (thumbnail) { // Simplified thumbnail handling for MCP
    texts.push(`Thumbnail: ${thumbnail}`);
  }
  if (url) texts.push(`URL: ${url}`);
  if (author_url) texts.push(`Author URL: ${author_url}`);
  return { success: true, result: texts.join('\n') };
}


const exts = {
  j: 'jpg',
  p: 'png',
  g: 'gif',
};

// @ts-ignore
const nhentaiApi = new NHentaiApi.API();

const getNHentaiSearchURL = (keyword: string) => encodeURI(nhentaiApi.search(keyword));

async function getDetailFromNHentaiAPI(name: string) {
  // Skipping Puppeteer implementation for now
  const get = axios.get; // Using axios directly

  let json = await get(getNHentaiSearchURL(`${name} chinese`)).then(r => r.data);
  if (json.result.length === 0) {
    json = await get(getNHentaiSearchURL(name)).then(r => r.data);
    if (json.result.length === 0) return;
  }
  const data = json.result[0];

  return {
    url: `https://nhentai.net/g/${data.id}/`,
    thumb: `https://t.nhentai.net/galleries/${data.media_id}/cover.${exts[data.images.thumbnail.t as keyof typeof exts]}`,
  };
}

async function getDetailFromNHentaiWebsite(origin: string, name: string) {
  return (await _getDetailFromNHentaiWebsite(origin, `${name} chinese`)) || (await _getDetailFromNHentaiWebsite(origin, name));
}

async function _getDetailFromNHentaiWebsite(origin: string, name: string) {
  const { data } = await axios.get(`${origin}/search/?q=${encodeURIComponent(name)}`, { responseType: 'text' });
  const $ = Cheerio.load(data);

  const gallery = $('.gallery').get(0);
  if (!gallery) return;
  const $gallery = $(gallery);

  const href = $gallery.find('a').attr('href');
  if (!href) return;
  const url = `https://nhentai.net${href}`;

  const $img = $gallery.find('img');
  const thumb = $img.attr('data-src') || $img.attr('src');
  if (!thumb) return;

  return { url, thumb };
}


class SaucenaoSearchServer {
	private server: Server;

	constructor() {
		this.server = new Server(
			{
				name: 'saucenao-search-server',
				version: '0.1.0',
			},
			{
				capabilities: {
					tools: {},
				},
			}
		);

		this.setupToolHandlers();

		// Error handling
		this.server.onerror = (error) => console.error('[MCP Error]', error);
		process.on('SIGINT', async () => {
			await this.server.close();
			process.exit(0);
		});
	}

	private setupToolHandlers() {
		this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [
				{
					name: 'saucenao_search',
					description: 'Search for the source of an image using SauceNAO',
					inputSchema: {
						type: 'object',
						properties: {
							imageUrl: {
								type: 'string',
								description: 'URL of the image to search',
								format: 'url',
							},
							imageBuffer: {
								type: 'string',
								description: 'Base64 encoded image buffer',
							},
							db: {
								type: 'string',
								description: 'Search database (e.g., "all", "pixiv", "danbooru", "book", "doujin", "anime")',
								enum: Object.keys(snDB),
								default: 'all',
							},
						},
						oneOf: [
							{ required: ['imageUrl'] },
							{ required: ['imageBuffer'] },
						],
					},
				},
				{
					name: 'ascii2d_search',
					description: 'Search for the source of an image using ascii2d',
					inputSchema: {
						type: 'object',
						properties: {
							imageUrl: {
								type: 'string',
								description: 'URL of the image to search',
								format: 'url',
							},
							imageBuffer: {
								type: 'string',
								description: 'Base64 encoded image buffer',
							},
						},
						oneOf: [
							{ required: ['imageUrl'] },
							{ required: ['imageBuffer'] },
						],
					},
				},
				{
					name: 'nhentai_search',
					description: 'Search for doujinshi on nhentai by name',
					inputSchema: {
						type: 'object',
						properties: {
							name: {
								type: 'string',
								description: 'Name of the doujinshi to search for',
							},
						},
						required: ['name'],
					},
				},
			],
		}));

		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			try {
				if (request.params.name === 'saucenao_search') {
					const { imageUrl, imageBuffer, db = 'all' } = request.params.arguments as SaucenaoSearchParams;

					if (!imageUrl && !imageBuffer) {
						throw new McpError(ErrorCode.InvalidParams, 'Either imageUrl or imageBuffer must be provided.');
					}

					const searchDb = snDB[db as keyof typeof snDB];
					if (searchDb === undefined) {
						throw new McpError(ErrorCode.InvalidParams, `Invalid database specified: ${db}`);
					}

					const img: MsgImage = {
						isUrlValid: !!imageUrl,
						url: imageUrl,
						getPath: async () => {
							if (imageBuffer) {
								const tempDir = require('os').tmpdir();
								const tempFilePath = require('path').join(tempDir, `upload_${Date.now()}.png`);
								require('fs').writeFileSync(tempFilePath, Buffer.from(imageBuffer, 'base64'));
								return tempFilePath;
							}
							return undefined;
						},
					};

					const ret = await getSearchResult(SAUCENAO_HOST, SAUCENAO_API_KEY!, img, searchDb);
					const data = ret.data;

					if (typeof data !== 'object' || !data.results || data.results.length === 0) {
						return {
							content: [{ type: 'text', text: 'No results found.' }],
						};
					}

					const results = data.results.map((result: any) => {
						const { header, data } = result;
						const similarity = parseFloat(header.similarity).toFixed(2);
						const title = data.title || data.source || '';
						const author = data.member_name || data.author || data.artist || '';
						const url = data.ext_urls ? data.ext_urls[0] : '';

						return {
							similarity,
							title,
							author,
							url,
							thumbnail: header.thumbnail,
							index_id: header.index_id,
						};
					});

					const outputText = results.map((res: any) => {
						let text = `相似度: ${res.similarity}%\n`;
						if (res.title) text += `标题: ${res.title}\n`;
						if (res.author) text += `作者: ${res.author}\n`;
						if (res.url) text += `链接: ${res.url}\n`;
						return text;
					}).join('---\n');

					return {
						content: [
							{
								type: 'text',
								text: outputText,
							},
							{
								type: 'application/json',
								json: { results },
							}
						],
					};

				} else if (request.params.name === 'ascii2d_search') {
					const { imageUrl, imageBuffer } = request.params.arguments as { imageUrl?: string; imageBuffer?: string };

					if (!imageUrl && !imageBuffer) {
						throw new McpError(ErrorCode.InvalidParams, 'Either imageUrl or imageBuffer must be provided.');
					}

					const img: MsgImage = {
						isUrlValid: !!imageUrl,
						url: imageUrl,
						getPath: async () => {
							if (imageBuffer) {
								const tempDir = require('os').tmpdir();
								const tempFilePath = require('path').join(tempDir, `upload_${Date.now()}.png`);
								require('fs').writeFileSync(tempFilePath, Buffer.from(imageBuffer, 'base64'));
								return tempFilePath;
							}
							return undefined;
						},
					};

					const ascii2dResults = await doAscii2dSearch(img);

					let outputText = '';
					if (ascii2dResults.color) outputText += ascii2dResults.color + '\n';
					if (ascii2dResults.bovw) outputText += ascii2dResults.bovw + '\n';

					if (!ascii2dResults.success) {
						outputText += 'ascii2d search might not be successful.';
					}


					return {
						content: [
							{
								type: 'text',
								text: outputText.trim(),
							},
							// Optionally return structured data
							{
								type: 'application/json',
								json: ascii2dResults,
							}
						],
					};

				} else if (request.params.name === 'nhentai_search') {
					const { name } = request.params.arguments as { name: string };
					const NHENTAI_MIRROR_SITE = process.env.NHENTAI_MIRROR_SITE;

					if (!name) {
						throw new McpError(ErrorCode.InvalidParams, 'Name parameter is required for nhentai search.');
					}

					// Prioritize API search, fallback to website search if mirror site is configured
					const nhentaiResult = await getDetailFromNHentaiAPI(name) || (NHENTAI_MIRROR_SITE ? await getDetailFromNHentaiWebsite(NHENTAI_MIRROR_SITE, name) : undefined);


					if (!nhentaiResult) {
						return {
							content: [{ type: 'text', text: `No results found for "${name}" on nhentai.` }],
						};
					}

					const outputText = `URL: ${nhentaiResult.url}\nThumbnail: ${nhentaiResult.thumb}`;

					return {
						content: [
							{
								type: 'text',
								text: outputText,
							},
							// Optionally return structured data
							{
								type: 'application/json',
								json: nhentaiResult,
							}
						],
					};

				} else {
					throw new McpError(
						ErrorCode.MethodNotFound,
						`Unknown tool: ${request.params.name}`
					);
				}
			} catch (error: any) {
				if (axios.isAxiosError(error)) {
					return {
						content: [
							{
								type: 'text',
								text: `API error: ${
									error.response?.data.message ?? error.message
								}`,
							},
						],
						isError: true,
					};
				}
				if (error instanceof McpError) {
					return {
						content: [{ type: 'text', text: `MCP Error: ${error.message}` }],
						isError: true,
					};
				}
				return {
					content: [{ type: 'text', text: `An unexpected error occurred: ${error.message}` }],
					isError: true,
				};
			} finally {
				// Clean up temporary file if created for imageBuffer
				const { imageBuffer } = request.params.arguments as any; // Use any for finally block
				if (imageBuffer) {
					const tempDir = require('os').tmpdir();
					const tempFilePath = require('path').join(tempDir, `upload_${Date.now()}.png`);
					if (require('fs').existsSync(tempFilePath)) {
						require('fs').unlinkSync(tempFilePath);
					}
				}
			}
		});
	}

	async run() {
		const transport = new StdioServerTransport();
		await this.server.connect(transport);
		console.error('SauceNAO Search MCP server running on stdio');
	}
}

const server = new SaucenaoSearchServer();
server.run().catch(console.error);
