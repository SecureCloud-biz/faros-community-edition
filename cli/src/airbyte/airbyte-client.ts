import retry from 'async-retry';
import axios, {AxiosInstance} from 'axios';
import {ceil} from 'lodash';
import ProgressBar from 'progress';
import {VError} from 'verror';

import {wrapApiError} from '../cli';
import {display, Emoji, errorLog, sleep, terminalLink} from '../utils';

export class Airbyte {
  private readonly api: AxiosInstance;
  private readonly airbyteUrl: string;

  constructor(airbyteUrl: string) {
    this.airbyteUrl = airbyteUrl.replace(/\/+$/, '');
    this.api = axios.create({
      baseURL: `${this.airbyteUrl}/api/v1`,
    });
  }

  async waitUntilHealthy(): Promise<void> {
    display('Checking connection with Airbyte %s', Emoji.CHECK_CONNECTION);

    await retry(
      async () => {
        await this.api
          .get('/health')
          .then((response) => {
            if (!(response.data.available ?? false)) {
              throw new VError('Airbyte is not healthy yet');
            }
          })
          .catch((err) => {
            throw wrapApiError(err, 'Could not connect to Airbyte');
          });
      },
      {
        retries: 5,
        minTimeout: 1000,
        maxTimeout: 1000,
      }
    );
  }

  async setupSource(config: any): Promise<void> {
    display('Setting up source %s', Emoji.SETUP);
    await this.api
      .post('/sources/check_connection_for_update', config)
      .catch((err) => {
        throw wrapApiError(
          err,
          'Failed to call /sources/check_connection_for_update'
        );
      });

    await this.api.post('/sources/update', config).catch((err) => {
      throw wrapApiError(err, 'Failed to call /sources/update');
    });

    display('Setup succeeded %s', Emoji.SUCCESS);
  }

  async triggerSync(connectionId: string): Promise<number> {
    const response = await this.api
      .post('/connections/sync', {
        connectionId,
      })
      .catch((err) => {
        throw wrapApiError(err, 'Failed to call /connections/sync');
      });
    return response.data.job.id;
  }

  async getJobStatus(job: number): Promise<string> {
    const response = await this.api
      .post('/jobs/get', {
        id: job,
      })
      .catch((err) => {
        throw wrapApiError(err, ' Failed to call /jobs/get');
      });
    return response.data.job.status;
  }

  async triggerAndTrackSync(
    connectionId: string,
    days: number,
    entries: number
  ): Promise<void> {
    try {
      display(
        'Syncing %s days of data for %s repos/projects %s',
        days,
        entries,
        Emoji.SYNC
      );
      const duration_lower = ceil(entries * days) / 30;
      const duration_upper = 2 * duration_lower;
      display(
        'Time to get that data is typically between %s and %s minutes %s',
        duration_lower,
        duration_upper,
        Emoji.STOPWATCH
      );
      const job = await this.triggerSync(connectionId);

      const syncBar = new ProgressBar(':bar', {
        total: 2,
        complete: process.env.FAROS_NO_EMOJI ? '.' : Emoji.PROGRESS,
        incomplete: ' ',
      });

      let val = 1;
      let running = true;
      while (running) {
        syncBar.tick(val);
        val *= -1;
        const status = await this.getJobStatus(job);
        if (status !== 'running') {
          running = false;
          syncBar.terminate();
          if (status !== 'succeeded') {
            errorLog(
              `Sync ${status}. %s Please check the ${await terminalLink(
                'logs',
                this.airbyteStatusUrl(connectionId)
              )}`,
              Emoji.FAILURE
            );
          } else {
            display('Syncing succeeded %s', Emoji.SUCCESS);
          }
        }
        await sleep(1000);
      }
    } catch (error) {
      errorLog(
        `Sync failed. %s Please check the ${await terminalLink(
          'logs',
          this.airbyteStatusUrl(connectionId)
        )}`,
        Emoji.FAILURE,
        error
      );
    }
  }

  private airbyteStatusUrl(connectionId: string): string {
    return `${this.airbyteUrl}/connections/${connectionId}/status`;
  }
}
