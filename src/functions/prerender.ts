import 'core-js/es/reflect'; // tslint:disable-line:no-submodule-imports
import { experimental } from '@angular-devkit/core'; // tslint:disable-line:ordered-imports
import chalk from 'chalk';
import { mkdir, readFile, writeFile } from 'fs';
import { parseAngularRoutes } from 'guess-parser';
import { dirname, join } from 'path';
import { cwd } from 'process';
import { promisify } from 'util';
import { IParameterValuesMap, IPartialExpressResponse, IPartialHapiResponse } from '../interfaces';
import { TEnableProdModeFunction, TReadPropertyFunction, TTargetSpecifier } from '../types';
import { bindRenderFunction } from './bind-render-function';
import { resolveRoutes } from './resolve-routes';
import { unbundleTokens } from './unbundle-tokens';

const mkdirAsync = promisify(mkdir);
const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);

export const prerender = async (
    browserTarget: TTargetSpecifier,
    config: string,
    enableProdMode: TEnableProdModeFunction,
    excludeRoutes: string[],
    expressResponseToken: any,
    hapiResponseToken: any,
    isVerbose: boolean,
    parameterValuesMap: IParameterValuesMap,
    readProperty: TReadPropertyFunction,
    serverTarget: TTargetSpecifier,
    shouldIgnoreStatusCode: boolean,
    shouldPreserveIndexHtml: boolean
) => {
    enableProdMode();

    if (isVerbose) {
        console.log(chalk`{gray The path of the angular.json config file is "${ config }".}`); // tslint:disable-line:max-line-length no-console
    }

    const { defaultProject, projects } = <experimental.workspace.WorkspaceSchema> require(config);

    const browserOutputPath = join(dirname(config), readProperty(projects, defaultProject, browserTarget, 'outputPath'));
    const serverOutputPath = join(dirname(config), readProperty(projects, defaultProject, serverTarget, 'outputPath'));

    if (isVerbose) {
        console.log(chalk`{gray The resolved output path of the browser target is "${ browserOutputPath }".}`); // tslint:disable-line:max-line-length no-console
        console.log(chalk`{gray The resolved output path of the server target is "${ serverOutputPath }".}`); // tslint:disable-line:max-line-length no-console
    }

    const main = join(serverOutputPath, 'main');

    if (isVerbose) {
        console.log(chalk`{gray The path of the main.js file is "${ main }".}`); // tslint:disable-line:max-line-length no-console
    }

    const unbundledMain = await unbundleTokens(main);

    if (isVerbose && main !== unbundledMain) {
        console.log(chalk`{gray The main.js contains bundled tokens which have been replaced with classic require statements.}`); // tslint:disable-line:max-line-length no-console
    }

    const render = bindRenderFunction(unbundledMain);

    const index = join(browserOutputPath, 'index.html');

    if (isVerbose) {
        console.log(chalk`{gray The path of the index.html file is "${ index }".}`); // tslint:disable-line:max-line-length no-console
    }

    const document = await readFileAsync(index, 'utf8');
    const tsConfig = join(cwd(), readProperty(projects, defaultProject, browserTarget, 'tsConfig'));

    if (isVerbose) {
        console.log(chalk`{gray The path of the tsconfig.json file used to retrieve the routes is "${ tsConfig }".}`); // tslint:disable-line:max-line-length no-console
    }

    const routes: { path: string }[] = parseAngularRoutes(tsConfig);

    if (routes.length === 0) {
        console.log(chalk`{yellow No routes could be retrieved thus the default route at "/" will be added.}`); // tslint:disable-line:max-line-length no-console

        routes.push({ path: '/' });
    }

    const renderableRoutes = routes
        .map(({ path }) => path)
        .filter((route) => {
            if (route.match(/\*\*/) !== null) {
                console.log(chalk`{yellow The route at "${ route }" will not be rendered because it contains a wildcard.}`); // tslint:disable-line:max-line-length no-console

                return false;
            }

            if (excludeRoutes.includes(route)) {
                console.log(chalk`{yellow The route at "${ route }" was excluded.}`); // tslint:disable-line:max-line-length no-console

                return false;
            }

            return route
                .split(/\//)
                .every((segment) => {
                    if (segment.startsWith(':') && parameterValuesMap[segment] === undefined) {
                        console.log(chalk`{yellow The route at "${ route }" will not be rendered because it contains a segement with an unspecified parameter "${ segment }".}`); // tslint:disable-line:max-line-length no-console

                        return false;
                    }

                    return true;
                });
        });

    const resolvedRoutes = resolveRoutes(renderableRoutes, parameterValuesMap);

    for (const route of resolvedRoutes) {
        const path = join(browserOutputPath, route);

        await mkdirAsync(path, { recursive: true });

        let statusCode = 200;

        const expressResponse: IPartialExpressResponse = {
            status: (value) => {
                statusCode = value;

                return expressResponse;
            }
        };

        const hapiResponse: IPartialHapiResponse = {
            code: (value) => {
                statusCode = value;

                return hapiResponse;
            }
        };

        const html = await render({
            document,
            extraProviders: [
                (expressResponseToken === null)
                    ? [ ]
                    : {
                        provide: expressResponseToken,
                        useValue: expressResponse
                    },
                (hapiResponseToken === null)
                    ? [ ]
                    : {
                        provide: hapiResponseToken,
                        useValue: hapiResponse
                    }
            ],
            url: route
        });

        if (shouldIgnoreStatusCode || statusCode < 300) {
            if (path === browserOutputPath) {
                if (shouldPreserveIndexHtml) {
                    console.log(chalk`{green The index.html file will be preserved as start.html because it would otherwise be overwritten.}`); // tslint:disable-line:no-console

                    await writeFileAsync(join(browserOutputPath, 'start.html'), document);
                } else {
                    console.log(chalk`{yellow The index.html file will be overwritten by the following route. This can be prevented by using the --preserve-index-html flag.}`); // tslint:disable-line:max-line-length no-console
                }
            }

            await writeFileAsync(join(path, 'index.html'), html);

            console.log(chalk`{green The route at "${ route }" was rendered successfully.}`); // tslint:disable-line:no-console
        } else {
            console.log(chalk`{yellow The route at "${ route }" was skipped because it's status code was ${ statusCode }.}`); // tslint:disable-line:max-line-length no-console
        }
    }
};
