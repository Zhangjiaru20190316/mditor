// 本地单测套件入口（hypium）——hvigorw test 或 DevEco「Local Test」执行。

import LocalUnit from './LocalUnit.test';

export default function testsuite() {
  LocalUnit();
}
