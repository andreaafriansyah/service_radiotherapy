
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

const HL7_LISTEN_PORT = 9903;
const MLLP_TARGET_HOST = '10.4.32.98';
const MLLP_TARGET_PORT = 9900;
const PHP_ENDPOINT = 'http://localhost/teramedik/?mod=bridging_rad&cmd=sub_insert_data';

// Konfigurasi logger harian
const transport = new winston.transports.DailyRotateFile({
    filename: 'logs/hl7-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '5m',
    maxFiles: '7d'
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(info => `[${info.timestamp}] ${info.message}`)
    ),
    transports: [transport]
});

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/send', (req, res) => {
    const hl7_message = req.body.hl7;
    if (!hl7_message) return res.status(400).send('Missing HL7 data');

    const mllpMessage = String.fromCharCode(0x0B) + hl7_message + String.fromCharCode(0x1C) + String.fromCharCode(0x0D);
    const client = new net.Socket();
    client.connect(MLLP_TARGET_PORT, MLLP_TARGET_HOST, () => client.write(mllpMessage));

    let response = '';
    client.on('data', (data) => response += data.toString());
    client.on('end', () => res.send({ status: 'sent', response }));
    client.on('error', (err) => res.status(500).send({ error: err.message }));
});

const socketServer = net.createServer(socket => {
    console.log(`[Socket] Connection from ${socket.remoteAddress}`);
    socket.on('data', async (data) => {
        const raw = data.toString('utf-8').trim();
        console.log('[Socket] Received HL7:', raw.replace(/\r/g, '\n'));

        logger.info(`Received from ${socket.remoteAddress}:\n${raw}`);

        const lines = raw.split(/\r?\n/);
        const segments = {};
        lines.forEach(line => {
            const parts = line.split('|');
            segments[parts[0]] = parts;
        });

        const patientId = segments['PID']?.[3] || '';
        const patientName = segments['PID']?.[5] || '';
        const procedure = segments['AIS']?.[3] || segments['SCH']?.[6] || '';
        const location = segments['AIL']?.[3] || '';
        const startTime = segments['SCH']?.[11]?.split('^')[3] || '';
        const endTime = segments['SCH']?.[11]?.split('^')[4] || '';

        logger.info(`Parsed HL7 → patient_id=${patientId}, name=${patientName}, procedure=${procedure}, location=${location}, start=${startTime}, end=${endTime}`);

        const parsed = {
            patient_id: patientId,
            patient_name: patientName,
            procedure,
            location,
            start_time: startTime,
            end_time: endTime
        };

        try {
            const res = await axios.post(PHP_ENDPOINT, parsed);
            logger.info(`Sent to Teramedik. Response: ${res.data}`);
            console.log(`[Teramedik] Sent. Response:`, res.data);
        } catch (e) {
            logger.info(`ERROR sending to Teramedik: ${e.message}`);
            console.error('[Teramedik ERROR]', e.message);
        }

        socket.write('ACK\n');
    });
});

socketServer.listen(HL7_LISTEN_PORT, () => console.log(`[HL7 Listener] Listening on port ${HL7_LISTEN_PORT}`));
app.listen(3000, () => console.log(`[Express] HTTP API started on port 3000`));
