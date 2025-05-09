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
import FormData from 'form-data';
import { readFileSync, statSync } from 'fs'; // 导入 statSync
import path from 'path';
import { readdir } from 'fs/promises';

const API_KEY = process.env.SAUCENAO_API_KEY; // provided by MCP config
if (!API_KEY) {
	throw new Error('SAUCENAO_API_KEY environment variable is required');
}

const IMAGE_CACHE_PATH = process.env.IMAGE_CACHE_PATH; // provided by MCP config
console.error(`[DEBUG] IMAGE_CACHE_PATH: ${IMAGE_CACHE_PATH}`);
if (!IMAGE_CACHE_PATH) {
	console.warn('IMAGE_CACHE_PATH environment variable is not set. imageDirectory functionality may be limited.');
}

const VALID_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

// 参考 src/plugin/saucenao.mjs 中的 snDB
const snDB = {
	all: 999,
	pixiv: 5,
	danbooru: 9,
	book: 18,
	doujin: 18,
	anime: 21,
	原图: 10000,
};

interface SauceNAOResult {
	header: {
		similarity: string;
		thumbnail: string;
		index_id: number;
		hidden: number;
	};
	data: {
		ext_urls?: string[];
		title?: string;
		member_name?: string;
		member_id?: number;
		eng_name?: string;
		jp_name?: string;
		source?: string;
		author?: string;
		artist?: string;
	};
}

interface SauceNAOApiResponse {
	results?: SauceNAOResult[];
	header: {
		message?: string;
	};
}

class SauceNAOServer {
	private server: Server;
	private axiosInstance;

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

		this.axiosInstance = axios.create({
			baseURL: 'https://saucenao.com',
			params: {
				appid: API_KEY,
				output_type: 2,
				numres: 3,
			},
		});

		this.setupToolHandlers();

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
					name: 'search-image',
					description: 'Search for an image using SauceNAO. Provide either a direct imagePath or an imageDirectory.',
					inputSchema: {
						type: 'object',
						properties: {
							imagePath: {
								type: 'string',
								description: 'The direct path to the image file to search.',
							},
							imageDirectory: {
								type: 'string',
								description: 'The directory (relative to IMAGE_CACHE_PATH or absolute if IMAGE_CACHE_PATH is not set) to search for the latest image file. IMPORTANT: If the user sends an image directly without specifying a path, set this parameter to an empty string (""). The server will then use the IMAGE_CACHE_PATH. Note: This method relies on finding the most recently modified image file, which might lead to incorrect selections if multiple files are added concurrently.',
							},
							db: {
								type: 'string',
								description: 'The database to search (e.g., "all", "pixiv", "anime")',
								enum: Object.keys(snDB),
								default: 'all',
							},
						},
						required: [],
						anyOf: [
							{
								type: 'object',
								properties: {
									imagePath: { type: 'string' },
								},
								required: ['imagePath']
							},
							{
								type: 'object',
								properties: {
									imageDirectory: { type: 'string' },
								},
								required: ['imageDirectory']
							}
						]
					},
				},
			],
		}));

		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const args = request.params.arguments as { imagePath?: string; imageDirectory?: string; db?: keyof typeof snDB };

			if (request.params.name !== 'search-image') {
				throw new McpError(
					ErrorCode.MethodNotFound,
					`Unknown tool: ${request.params.name}`
				);
			}

			let imagePathToSearch: string | undefined;
			let directoryToSearch: string | undefined;

			if (args.imagePath) {
				imagePathToSearch = args.imagePath;
			} else if (args.imageDirectory !== undefined) {
				if (!IMAGE_CACHE_PATH) {
					throw new McpError(
						ErrorCode.InvalidParams,
						'IMAGE_CACHE_PATH environment variable is not set. Cannot use imageDirectory.'
					);
				}
				if (args.imageDirectory === "") {
					directoryToSearch = IMAGE_CACHE_PATH;
				} else {
					directoryToSearch = path.join(IMAGE_CACHE_PATH, args.imageDirectory);
				}
				
				console.error(`[DEBUG] Attempting to read directory: ${directoryToSearch}`);
				try {
					const filesInDir = await readdir(directoryToSearch);
					if (filesInDir.length === 0) {
						throw new McpError(
							ErrorCode.InvalidParams,
							`No files found in directory: ${directoryToSearch}`
						);
					}
					
					let latestFile: string | undefined;
					let latestMtime: Date | undefined;

					for (const file of filesInDir) {
						const fullPath = path.join(directoryToSearch, file);
						const fileStat = statSync(fullPath);
						const ext = path.extname(file).toLowerCase();
						if (fileStat.isFile() && VALID_IMAGE_EXTENSIONS.includes(ext)) {
							if (!latestMtime || fileStat.mtime > latestMtime) {
								latestMtime = fileStat.mtime;
								latestFile = fullPath;
							}
						}
					}

					if (latestFile) {
						imagePathToSearch = latestFile;
					} else {
						throw new McpError(
							ErrorCode.InvalidParams,
							`No valid image files found in directory: ${directoryToSearch}`
						);
					}

				} catch (error) {
					throw new McpError(
						ErrorCode.InvalidParams,
						`Error reading directory ${directoryToSearch}: ${error}`
					);
				}
			} else {
				throw new McpError(
					ErrorCode.InvalidParams,
					'Either imagePath or imageDirectory must be provided.'
				);
			}


			if (typeof imagePathToSearch !== 'string') {
				throw new McpError(
					ErrorCode.InvalidParams,
					'Could not determine image path from provided arguments.'
				);
			}
			console.error(`[DEBUG] Image path to search: ${imagePathToSearch}`);

			const dbId = snDB[args.db || 'all'];

			try {
				const form = new FormData();
				form.append('file', readFileSync(imagePathToSearch), path.basename(imagePathToSearch));

				const response = await this.axiosInstance.post<SauceNAOApiResponse>(
					'/search.php',
					form,
					{
						params: {
							api_key: API_KEY,
							output_type: 2,
							numres: 3,
							db: dbId,
						},
						headers: form.getHeaders(),
					}
				);

				const data = response.data;

				if (data.results && data.results.length > 0) {
					const result = data.results[0];
					const simText = parseFloat(result.header.similarity).toFixed(2);
					let title = result.data.title || result.data.source;
					const author = result.data.member_name || result.data.author || result.data.artist;
					if (author) {
						title = `「${title}」/「${author}」`;
					}
					const url = result.data.ext_urls ? result.data.ext_urls[0] : '';

					const output = {
						similarity: simText,
						title: title,
						url: url,
						thumbnail: result.header.thumbnail,
						index_id: result.header.index_id,
					};

					return {
						content: [
							{
								type: 'text',
								text: `相似度: ${output.similarity}%\n标题: ${output.title}\n链接: ${output.url}\n缩略图: ${output.thumbnail}`,
							},
						],
					};
				} else if (data.header.message) {
					return {
						content: [
							{
								type: 'text',
								text: `SauceNAO API Error: ${data.header.message}`,
							},
						],
						isError: true,
					};
				} else {
					return {
						content: [
							{
								type: 'text',
								text: 'SauceNAO search failed: No results found.',
							},
						],
						isError: true,
					};
				}
			} catch (error) {
				if (axios.isAxiosError(error)) {
					return {
						content: [
							{
								type: 'text',
								text: `SauceNAO request error: ${
									error.response?.data.message ?? error.message
								}`,
							},
						],
						isError: true,
					};
				}
				throw error;
			}
		});
	}

	async run() {
		const transport = new StdioServerTransport();
		await this.server.connect(transport);
		console.error('SauceNAO Search MCP server running on stdio');
	}
}

const server = new SauceNAOServer();
server.run().catch(console.error);
