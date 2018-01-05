/**
 * 一个用nodejs实现的爬虫
 * 灵感来自https://github.com/aosabook/500lines/tree/master/crawler
 */

(function(){
    "use strict";

    const assert = require('assert');
    const http = require('http');
    const https = require('https');
    const urlparse = require('url').parse;
    const queue = require('async').queue;

    const lenient_host = host => host.split('.').slice(-2).join('');
    const is_redirect = response => !![300, 301, 302, 303, 307].find(x => x === response.statusCode);
    const urljoin = (url1, url2) => {
        if (url2.indexOf('http') === 0) {
            return url2;
        }
        if (url2.indexOf('/') === 0) {
            url2 = url2.substring(1);
        }
        if (url1.substr(-1) !== '/') {
            url1 = url1 + '/';
        }
        return url1 + url2;
    }

    /**
     * 爬取一个URL集合.
     * 这个类管理一个URL集合: 'seen_urls'.
     * 'seen_urls' 是见过的URL.
    */
    class Crawler {
        constructor(roots, exclude=null, 
            strict=true, max_redirect=10, 
            max_tries=4, max_tasks=10, ...args) {

            assert(roots.constructor === Array && roots.length > 0, 'roots must be an array which not empty');

            this.roots = roots;
            this.exclude = exclude;
            this.strict = strict;
            this.max_redirect = max_redirect;
            this.max_tries = max_tries;
            this.max_tasks = max_tasks;
            this.seen_urls = [];
            this.root_domains = [];
            this.roots.forEach((root) => {
                let host = urlparse(root).host;
                if (!host) return;
                if (/\A[\d\.]*\Z/.test(host)) {
                    this.root_domains.push(host);
                } else {
                    host = host.toLowerCase();
                    if (this.strict) {
                        this.root_domains.push(host);
                    } else {
                        this.root_domains.push(lenient_host(host));
                    }
                }
            });
        }

        _get_queue() {
            let q = queue(async task => await task(), this.max_tasks);
            q.drain = () => console.log('all task done');
            return q;
        }

        /* 检查host是否有效 */
        host_okay(host) {
            if (!host) return false;
            host = host.toLowerCase();
            if (this.root_domains.find(x => x === host)) {
                return true;
            }
            if (/\A[\d\.]*\Z/.test(host)) {
                return false;
            }
            if (this.strict) {
                host = host.indexOf('www') === 0 ? host.substring(4) : 'www.' + host;
                return !!this.root_domains.find(x => x === host);
            } else {
                return !!this.root_domains.find(x => x === lenient_host(host));
            }
        }

        /* 检查url是否有效 */
        url_allowed(url) {
            if (this.exclude && this.exclude.test(url)) {
                return false;
            }
            let params = urlparse(url);
            if (['https:', 'http:'].findIndex(x => x === params.protocol) === -1) {
                return false;
            }
            return this.host_okay(params.host);
        }

        /* 把未出现过的url加入队列 */
        add_url(url, max_redirect=null) {
            if (max_redirect === null) {
                max_redirect = this.max_redirect;
            }
            this.seen_urls.push(url);
            this.q.push(() => this.fetch(url, max_redirect));
        }

        request(url) {
            let params = urlparse(url);
            let crawl = params.protocol === 'https:' ? https : http;
            return new Promise(async (resolve, reject) => {
                let options = urlparse(url);
                // hook
                if (this.agent_func) {
                    let user_agent = await this.agent_func();
                    options['headers'] = {
                        'User-Agent': user_agent
                    }
                }
                if (this.proxy_func) {
                    let proxy = await this.proxy_func();
                    options['host'] = proxy.host;
                    options['port'] = proxy.port;
                }
                let req = crawl.request(options, res => {
                    res.url = url;
                    resolve(res);
                });
                req.on('error', error => reject(error));
                req.end();
            });
        }

        parse_links(response) {
            let links = [];
            let content_type = null;
            let encoding = 'utf-8';
            if (response.statusCode === 200) {
                content_type = response.headers['content-type'];
                if (content_type.indexOf(';') !== -1) {
                    let params = content_type.split(';');
                    content_type = params[0];
                    if (params.length > 1 && params[1].indexOf('charset=') !== -1) {
                        encoding = params[1].replace(/\s/, '').replace('charset=', '');
                    }
                }
                if (['text/html', 'application/xml'].findIndex(x => x == content_type) !== -1) {
                    return new Promise(resolve => {
                        let body = "";
                        response.on('data', chunk => body += chunk);
                        response.on("end", async () => {
                            if (this.fetch_func) {
                                await this.fetch_func(response.url, body);
                            }
                            let reg = /href=["']([^\s"'<>]+)/g;
                            let r;
                            while (r = reg.exec(body)) {
                                let defragmented = urljoin(response.url, r[1]);
                                if (this.url_allowed(defragmented)) {
                                    links.push(defragmented);
                                }
                            }
                            if (links.length > 0) {
                                links = Array.from(new Set(links));
                            }
                            resolve(links);
                        });
                    });
                }
            }
            return links;
        }

        /* 抓取url */
        async fetch(url, max_redirect) {
            let tries = 0;
            let exception = null;
            let response = null;
            while(tries < this.max_tries) {
                try {
                    response = await this.request(url)
                    break;
                } catch(err) {
                    if (this.error_func) {
                        await this.error_func(url, err);
                    }
                }
                tries += 1;
            }
            if (tries >= this.tries || !response) {
                // 抓取失败了
                return;
            }
            if (is_redirect(response)) {
                let location = response.headers['location'];
                let next_url = urljoin(url, location);
                if (this.seen_urls.findIndex(x => x === next_url) !== -1) {
                    return;
                }
                if (max_redirect > 0) {
                    this.add_url(next_url, max_redirect - 1)
                } else {
                    console.log('redirect limit reached for ' + next_url + ' from ' + url);
                }
            } else {
                let links = await this.parse_links(response);
                links = links.filter(x => this.seen_urls.indexOf(x) < 0);
                links.forEach(link => {
                    this.q.push(() => this.fetch(link, this.max_redirect));
                    this.seen_urls.push(link);
                });
            }
        }

        on(hook, func) {
            if (hook === 'fetch') {
                this.fetch_func = (url, body) => {
                    return new Promise(resolve => {
                        func(url, body, function() {
                            resolve();
                        });
                    });
                }
            } else if (hook === 'error') {
                this.error_func = (url, err) => {
                    return new Promise(resolve => {
                        func(url, err, function() {
                            resolve();
                        });
                    });
                }
            }
        }

        use(hook, func) {
            if (hook === 'agent') {
                this.agent_func = () => {
                    return new Promise(resolve => {
                        func(function(user_agent) {
                            resolve(user_agent);
                        });
                    });
                }
            } else if (hook === 'proxy') {
                this.proxy_func = () => {
                    return new Promise(resolve => {
                        func(function(proxy) {
                            resolve(proxy);
                        });
                    });
                }
            }
        }

        start() {
            this.q = this._get_queue();
            this.roots.forEach((root) => this.add_url(root));
        }
    }

    function Export(roots) {
        return new Crawler(roots);
    }

    module.exports = Export;

})(this);