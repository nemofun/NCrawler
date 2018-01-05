"use strict";

const Crawler = require('./crawler.js');

const app = Crawler(['http://www.baidu.com']);

// app.use('agent', async next => {
//     let agent = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.75 Safari/537.36";
//     next(agent);
// });

// app.use('proxy', async next => {
//     next({host: '1.1.1.1', port: '8888'});
// });

app.on('fetch', async (url, body, next) => {
    console.log(url);
    next();
});

app.on('error', async (url, err) => {
    console.log(url, err);
    next();
});

app.start();