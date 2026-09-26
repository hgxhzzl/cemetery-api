/*
 Navicat Premium Data Transfer

 Source Server         : mysql
 Source Server Type    : MySQL
 Source Server Version : 80200
 Source Host           : your-mysql-host:3306
 Source Schema         : gm_data_000

 Target Server Type    : MySQL
 Target Server Version : 80200
 File Encoding         : 65001

 Date: 16/09/2026 12:51:01
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
CREATE DATABASE IF NOT EXISTS `gm_data_000` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE `gm_data_000`;


-- ----------------------------
-- Table structure for account
-- ----------------------------
DROP TABLE IF EXISTS `account`;
CREATE TABLE `account` (
  `idAccount` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '账户ID',
  `account` varchar(80) NOT NULL DEFAULT '' COMMENT '单位名称',
  `head` varchar(40) NOT NULL DEFAULT '' COMMENT '负责人名',
  `phone` varchar(40) NOT NULL DEFAULT '' COMMENT '账户电话',
  `password` varchar(100) NOT NULL DEFAULT '' COMMENT '账户密码(bcrypt哈希60字符) 20260916加宽',
  `enterpriseType` varchar(80) DEFAULT '' COMMENT '企业类型',
  `useStatus` varchar(80) DEFAULT '' COMMENT '使用状态',
  `startDate` datetime NOT NULL COMMENT '开始日期',
  `endDate` datetime NOT NULL COMMENT '结束日期',
  `address` varchar(200) DEFAULT '' COMMENT '单位地址',
  `dataBaseName` varchar(20) NOT NULL DEFAULT '' COMMENT '数据库名',
  `operator` varchar(40) NOT NULL DEFAULT '' COMMENT '操作人名',
  `modifyDate` datetime NOT NULL COMMENT '修改日期',
  `createDate` datetime NOT NULL COMMENT '创建日期',
  `isDeleted` smallint(1) unsigned zerofill NOT NULL DEFAULT '0' COMMENT '是否删除',
  `uuid` varchar(200) DEFAULT '',
  PRIMARY KEY (`idAccount`) USING BTREE,
  KEY `pk_id_gm_accout` (`idAccount`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Records of account
-- ----------------------------
INSERT INTO `account` VALUES (1000, '示例单位', '示例负责人', '13766891959', '$2a$10$JHmbFPcx68e.PJJFnkk7CeKDKR5ot7wlpyUpk0dy.DBTrTFNDs27e', 'statusType.enterpriseTypeEnum.privately', 'statusType.useStatusEnum.use', '2023-12-27 00:00:00', '2033-12-27 00:00:00', '示例地址', 'gm_data_000', '示例负责人', '2026-08-27 13:03:47', '2023-12-27 00:00:00', 0, '');

-- ----------------------------
-- Table structure for account_power
-- ----------------------------
DROP TABLE IF EXISTS `account_power`;
CREATE TABLE `account_power` (
  `idMenu` varchar(80) NOT NULL COMMENT '菜单ID',
  `useMenu` smallint(6) DEFAULT '0' COMMENT '使用',
  `operateCreate` smallint(6) DEFAULT '0' COMMENT '新建',
  `operateModify` smallint(6) DEFAULT '0' COMMENT '修改',
  `operateDelete` smallint(6) DEFAULT '0' COMMENT '删除',
  `operateExamine` smallint(6) DEFAULT '0' COMMENT '核对',
  `operateFinish` smallint(6) DEFAULT '0' COMMENT '完成',
  `operatePower` smallint(6) DEFAULT '0' COMMENT '权限',
  `menuName` varchar(100) DEFAULT '' COMMENT '名称',
  `dataBaseName` varchar(20) NOT NULL DEFAULT '' COMMENT '数据库名',
  `level` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '级别',
  `account` varchar(80) NOT NULL DEFAULT '' COMMENT '单位名称',
  `menuDescribe` varchar(200) DEFAULT NULL COMMENT '菜单描述',
  PRIMARY KEY (`idMenu`,`dataBaseName`) USING BTREE,
  KEY `pk_id_gm_accout` (`idMenu`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Records of account_power
-- ----------------------------
INSERT INTO `account_power` VALUES ('101100', 1, 0, 0, 0, 0, 0, 0, 'menu.user', 'gm_data_000', 1, '', 'menu.userDescribe');
INSERT INTO `account_power` VALUES ('101101', 1, 1, 1, 1, 0, 0, 0, 'menu.account', 'gm_data_000', 2, '', 'menu.accountDescribe');
INSERT INTO `account_power` VALUES ('101102', 1, 1, 1, 1, 0, 0, 0, 'menu.contract', 'gm_data_000', 2, '', 'menu.contractDescribe');
INSERT INTO `account_power` VALUES ('102100', 1, 0, 0, 0, 0, 0, 0, 'menu.set', 'gm_data_000', 1, '', 'menu.setDescribe');
INSERT INTO `account_power` VALUES ('102102', 1, 0, 0, 0, 0, 0, 0, 'menu.tagInfo', 'gm_data_000', 2, '', 'menu.tagInfoDescribe');
INSERT INTO `account_power` VALUES ('102103', 1, 0, 0, 0, 0, 0, 0, 'menu.park', 'gm_data_000', 2, '', 'menu.parkDescribe');
INSERT INTO `account_power` VALUES ('102104', 1, 1, 1, 1, 0, 0, 1, 'menu.operator', 'gm_data_000', 2, '', 'menu.operatorDescribe');
INSERT INTO `account_power` VALUES ('102105', 1, 0, 0, 0, 0, 0, 0, 'menu.receiptConfig', 'gm_data_000', 2, '', 'menu.receiptConfigDescribe');
INSERT INTO `account_power` VALUES ('103100', 1, 0, 0, 0, 0, 0, 0, 'menu.operate', 'gm_data_000', 1, '', 'menu.operateDescribe');
INSERT INTO `account_power` VALUES ('103101', 1, 1, 1, 1, 0, 0, 0, 'menu.gravePlotBusiness', 'gm_data_000', 2, '', 'menu.gravePlotBusinessDescribe');
INSERT INTO `account_power` VALUES ('103107', 1, 1, 1, 0, 0, 0, 0, 'menu.room', 'gm_data_000', 2, '', 'menu.roomDescribe');
INSERT INTO `account_power` VALUES ('103102', 1, 1, 1, 1, 0, 0, 0, 'menu.sale', 'gm_data_000', 2, '', 'menu.saleDescribe');
INSERT INTO `account_power` VALUES ('103103', 1, 1, 1, 1, 0, 0, 0, 'menu.buried', 'gm_data_000', 2, '', 'menu.buriedDescribe');
INSERT INTO `account_power` VALUES ('103104', 1, 1, 1, 1, 0, 0, 0, 'menu.reserve', 'gm_data_000', 2, '', 'menu.reserveDescribe');
INSERT INTO `account_power` VALUES ('103105', 1, 1, 1, 1, 0, 0, 0, 'menu.contacts', 'gm_data_000', 2, '', 'menu.contactsDescribe');
INSERT INTO `account_power` VALUES ('103106', 1, 1, 1, 1, 0, 0, 0, 'menu.transferOut', 'gm_data_000', 2, '', 'menu.transferOutDescribe');
INSERT INTO `account_power` VALUES ('104100', 1, 0, 0, 0, 0, 0, 0, 'menu.fee', 'gm_data_000', 1, '', 'menu.feeDescribe');
INSERT INTO `account_power` VALUES ('103108', 1, 1, 1, 1, 0, 0, 0, 'menu.admifee', 'gm_data_000', 2, '', 'menu.admifeeDescribe');
INSERT INTO `account_power` VALUES ('103109', 1, 0, 1, 0, 0, 0, 0, 'menu.managementPeriod', 'gm_data_000', 2, '', 'menu.managementPeriodDescribe');
INSERT INTO `account_power` VALUES ('105100', 1, 0, 0, 0, 0, 0, 0, 'menu.query', 'gm_data_000', 1, '', 'menu.queryDescribe');
INSERT INTO `account_power` VALUES ('105101', 1, 0, 0, 0, 0, 0, 0, 'menu.saleQuery', 'gm_data_000', 2, '', 'menu.saleQueryDescribe');
INSERT INTO `account_power` VALUES ('105102', 1, 0, 0, 0, 0, 0, 0, 'menu.buriedQuery', 'gm_data_000', 2, '', 'menu.buriedQueryDescribe');
INSERT INTO `account_power` VALUES ('105103', 1, 0, 0, 0, 0, 0, 0, 'menu.adminfeeQuery', 'gm_data_000', 2, '', 'menu.adminfeeQueryDescribe');
INSERT INTO `account_power` VALUES ('105104', 1, 0, 0, 0, 0, 0, 0, 'menu.contactsQuery', 'gm_data_000', 2, '', 'menu.contactsQueryDescribe');
INSERT INTO `account_power` VALUES ('105105', 1, 1, 1, 1, 0, 0, 0, 'menu.transferOutQuery', 'gm_data_000', 2, '', 'menu.transferOutQueryDescribe');


-- ----------------------------
-- Table structure for contract
-- ----------------------------
DROP TABLE IF EXISTS `contract`;
CREATE TABLE `contract` (
  `idContract` bigint(20) NOT NULL AUTO_INCREMENT COMMENT 'ID',
  `contractName` varchar(100) DEFAULT '' COMMENT '合同名称',
  `contractNum` varchar(100) DEFAULT '' COMMENT '合同编号',
  `contractType` varchar(100) DEFAULT '0' COMMENT '合同类型',
  `payType` varchar(100) DEFAULT NULL COMMENT '收付方式',
  `partyA` varchar(100) DEFAULT NULL COMMENT '甲方',
  `partyB` varchar(100) DEFAULT NULL COMMENT '乙方',
  `paymentType` varchar(100) DEFAULT '0' COMMENT '付款类型',
  `contractAmount` varchar(100) DEFAULT '' COMMENT '合同金额',
  `contractStatus` varchar(100) DEFAULT NULL COMMENT '合同状态',
  `signDate` datetime DEFAULT NULL COMMENT '合同签订日期',
  `startDate` datetime DEFAULT NULL COMMENT '合同生效日期',
  `endDate` datetime DEFAULT NULL COMMENT '合同结束日期',
  `contracInfo` varchar(100) DEFAULT '' COMMENT '合同信息',
  `remark` varchar(200) DEFAULT NULL COMMENT '备注',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  `isDeleted` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否删除',
  `files` varchar(255) DEFAULT '',
  PRIMARY KEY (`idContract`) USING BTREE,
  KEY `pk_id_gm_accout` (`idContract`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Table structure for menu
-- ----------------------------
DROP TABLE IF EXISTS `menu`;
CREATE TABLE `menu` (
  `id` varchar(80) NOT NULL COMMENT '菜单ID',
  `path` varchar(80) NOT NULL DEFAULT '' COMMENT '账户ID',
  `name` varchar(80) NOT NULL DEFAULT '' COMMENT '用户名称',
  `component` varchar(80) NOT NULL DEFAULT '' COMMENT '用户电话',
  `redirect` varchar(80) NOT NULL DEFAULT '' COMMENT '用户密码',
  `icon` varchar(80) DEFAULT '',
  `parent_id` varchar(80) DEFAULT '',
  `zh_CN` varchar(80) NOT NULL DEFAULT '',
  `en_US` varchar(80) NOT NULL DEFAULT '' COMMENT '修改日期',
  PRIMARY KEY (`id`) USING BTREE,
  KEY `pk_id_gm_accout` (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Records of menu
-- ----------------------------
INSERT INTO `menu` VALUES ('101100', '/users', 'users', 'LAYOUT', '/users/base', 'user-setting', '0', '用户管理', 'Users');
INSERT INTO `menu` VALUES ('101101', 'account', 'account', '/account/index', '', NULL, '101100', '账户信息', 'Account');
INSERT INTO `menu` VALUES ('101102', 'contract', 'contract', '/contract/index', '', NULL, '101100', '合同列表', 'Contract');
INSERT INTO `menu` VALUES ('102100', '/set', 'set', 'LAYOUT', '/set/base', '\r\n\r\nsetting-1', '0', '基础设置', 'Settings');
INSERT INTO `menu` VALUES ('102102', 'taginfo', 'tagInfo', '/taginfo/index', '', NULL, '102100', '选择设置', 'Selection Settings');
INSERT INTO `menu` VALUES ('102103', 'park', 'park', '/park/index', '', NULL, '102100', '园区设置', 'Park Settings');
INSERT INTO `menu` VALUES ('102104', 'operator', 'operator', '/operator/index', '', NULL, '102100', '操作人员', 'Operator');
INSERT INTO `menu` VALUES ('102105', 'receiptConfig', 'receiptConfig', '/receiptConfig/index', '', NULL, '102100', '收据配制', 'receipt Config');
INSERT INTO `menu` VALUES ('103100', '/operate', 'operate', 'LAYOUT', '/operate/base', 'assignment', '0', '墓区业务', 'Cemetery Business');
INSERT INTO `menu` VALUES ('103101', 'gravePlotBusiness', 'gravePlotBusiness', '/gravePlotBusiness/index', '', NULL, '103100', '墓位业务', 'Grave Plot Business');
INSERT INTO `menu` VALUES ('103107', 'room', 'room', '/room/index', '', NULL, '103100', '墓位设置', 'Cemetery Area Settings');
INSERT INTO `menu` VALUES ('103102', 'sale', 'sale', '/sale/index', '', NULL, '103100', '墓区销售', 'Cemetery Sales');
INSERT INTO `menu` VALUES ('103103', 'buried', 'buried', '/buried/index', '', NULL, '103100', '墓区下葬', 'Cemetery Burials');
INSERT INTO `menu` VALUES ('103104', 'reserve', 'reserve', '/reserve/index', '', NULL, '103100', '墓区预定', 'Cemetery Reservations');
INSERT INTO `menu` VALUES ('103105', 'contacts', 'contacts', '/contacts/index', '', NULL, '103100', '墓位联系', 'Plot Contacts');
INSERT INTO `menu` VALUES ('103106', 'transferOut', 'transferOut', '/transferOut/index', '', NULL, '103100', '墓位迁出', 'Plot Transfer Out');
INSERT INTO `menu` VALUES ('104100', '/fee', 'fee', 'LAYOUT', '/fee/base', '\r\nalarm-add', '0', '收费管理', 'Fee Management');
INSERT INTO `menu` VALUES ('103108', 'adminfee', 'adminfee', '/adminfee/index', '', NULL, '103100', '管理费用收款', 'Admin Fee Collection');
INSERT INTO `menu` VALUES ('103109', 'managementPeriod', 'managementPeriod', '/managementPeriod/index', '', NULL, '103100', '管理期限维护', 'Management Period');
INSERT INTO `menu` VALUES ('105100', '/query', 'query', 'LAYOUT', '/query/base', '\r\nalarm-add', '0', '查询统计', 'Query Statistics');
INSERT INTO `menu` VALUES ('105101', 'saleQuery', 'saleQuery', '/saleQuery/index', '', '\r\n', '105100', '墓区销售查询', 'Cemetery Sale Query');
INSERT INTO `menu` VALUES ('105102', 'buriedQuery', 'buriedQuery', '/buriedQuery/index', '', '\r\n', '105100', '墓区下葬查询', 'Cemetery Burial Query');
INSERT INTO `menu` VALUES ('105103', 'adminfeeQuery', 'adminfeeQuery', '/adminfeeQuery/index', '', '\r\n', '105100', '管理收款查询', 'Admin Fee Query');
INSERT INTO `menu` VALUES ('105104', 'contactsQuery', 'contactsQuery', '/contactsQuery/index', '', '\r\n', '105100', '墓位联系查询', 'Plot Contact Query');
INSERT INTO `menu` VALUES ('105105', 'transferOutQuery', 'transferOutQuery', '/transferOut/index', '', '\r\n', '105100', '墓位迁出查询', 'Plot Transfer Out Query');

-- ----------------------------
-- Table structure for operator
-- ----------------------------
DROP TABLE IF EXISTS `operator`;
CREATE TABLE `operator` (
  `idOperator` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '用户ID',
  `name` varchar(40) DEFAULT '' COMMENT '姓名',
  `phone` varchar(40) NOT NULL DEFAULT '' COMMENT '账户电话',
  `duties` varchar(40) DEFAULT '' COMMENT '职务',
  `team` varchar(40) DEFAULT NULL COMMENT '团队',
  `useStatus` varchar(80) DEFAULT '' COMMENT '使用状态',
  `password` varchar(100) NOT NULL DEFAULT '' COMMENT '账户密码(bcrypt哈希60字符) 20260916加宽',
  `remark` varchar(255) DEFAULT '' COMMENT '备注',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  `isDeleted` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否删除',
  `isAccount` smallint(6) DEFAULT NULL COMMENT '是否账户',
  `dataBaseName` varchar(20) NOT NULL DEFAULT '' COMMENT '数据库名',
  `joinDate` date DEFAULT NULL COMMENT '入职日期',
  `isMaintenance` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否运维',
  PRIMARY KEY (`idOperator`) USING BTREE,
  KEY `pk_id_gm_accout` (`idOperator`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Records of operator
-- ----------------------------
INSERT INTO `operator` VALUES (1000, '示例管理员', '13766891959', '职员', '销售', 'statusType.useStatusEnum.use', '$2a$10$JHmbFPcx68e.PJJFnkk7CeKDKR5ot7wlpyUpk0dy.DBTrTFNDs27e', '', '示例管理员', '2026-08-27 13:03:47', '2024-01-10 00:00:00', 0, 1, 'gm_data_000', '2026-08-01', 0);

-- ----------------------------
-- Table structure for operator_power
-- ----------------------------
DROP TABLE IF EXISTS `operator_power`;
CREATE TABLE `operator_power` (
  `idPower` bigint(20) NOT NULL AUTO_INCREMENT COMMENT 'ID权限',
  `idOperator` bigint(20) DEFAULT NULL COMMENT 'ID操作员',
  `idMenu` varchar(80) DEFAULT NULL COMMENT 'ID菜单',
  `useMenu` smallint(6) DEFAULT '0' COMMENT '使用',
  `useCreate` smallint(6) DEFAULT '0' COMMENT '新建',
  `useModify` smallint(6) DEFAULT '0' COMMENT '修改',
  `useDelete` smallint(6) DEFAULT '0' COMMENT '删除',
  `useExamine` smallint(6) DEFAULT '0' COMMENT '核对',
  `useFinish` smallint(6) DEFAULT '0' COMMENT '完成',
  `usePower` smallint(6) DEFAULT '0' COMMENT '权限',
  PRIMARY KEY (`idPower`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=200000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Records of operator_power
-- ----------------------------
INSERT INTO `operator_power` VALUES (100001, 1000, '101100', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100002, 1000, '101101', 1, 1, 1, 1, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100003, 1000, '101102', 1, 1, 1, 1, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100004, 1000, '102100', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100005, 1000, '102102', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100006, 1000, '102103', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100007, 1000, '102104', 1, 1, 1, 1, 0, 0, 1);
INSERT INTO `operator_power` VALUES (100008, 1000, '103100', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100009, 1000, '103107', 1, 1, 1, 0, 0, 1, 0);
INSERT INTO `operator_power` VALUES (100010, 1000, '103102', 1, 1, 1, 1, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100011, 1000, '103103', 1, 1, 1, 1, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100012, 1000, '103104', 1, 1, 1, 1, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100013, 1000, '103105', 1, 1, 1, 1, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100014, 1000, '103106', 1, 1, 1, 1, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100015, 1000, '104100', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100016, 1000, '103108', 1, 1, 1, 1, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100017, 1000, '103109', 1, 0, 1, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100018, 1000, '105100', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100019, 1000, '105101', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100020, 1000, '105102', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100021, 1000, '105103', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100022, 1000, '105104', 1, 0, 0, 0, 0, 0, 0);
INSERT INTO `operator_power` VALUES (100023, 1000, '105105', 1, 0, 0, 0, 0, 0, 0);


-- ----------------------------
-- Table structure for taginfo
-- ----------------------------
DROP TABLE IF EXISTS `taginfo`;
CREATE TABLE `taginfo` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `tagName` varchar(255) DEFAULT NULL,
  `tagType` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Table structure for tagset
-- ----------------------------
DROP TABLE IF EXISTS `tagset`;
CREATE TABLE `tagset` (
  `dutiesNumber` smallint(6) DEFAULT NULL,
  `teamNumber` smallint(6) DEFAULT NULL,
  `regionNumber` smallint(6) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Records of tagset
-- ----------------------------
INSERT INTO `tagset` VALUES (2, 3, 4);


-- ----------------------------
-- Table structure for park
-- ----------------------------
DROP TABLE IF EXISTS `park`;
CREATE TABLE `park` (
  `idPark` bigint(20) NOT NULL AUTO_INCREMENT,
  `park` varchar(40) DEFAULT NULL,
  `region` varchar(40) DEFAULT NULL,
  PRIMARY KEY (`idPark`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;



-- ----------------------------
-- Table structure for room
-- ----------------------------
DROP TABLE IF EXISTS `room`;
CREATE TABLE `room` (
  `idRoom` bigint(20) NOT NULL AUTO_INCREMENT COMMENT 'ID房间',
  `region` varchar(20) NOT NULL COMMENT '区域名称',
  `park` varchar(20) NOT NULL COMMENT '园区名称',
  `roomType` varchar(100) NOT NULL COMMENT '房间类型',
  `xNum` smallint(6) NOT NULL COMMENT 'X编号',
  `yNum` smallint(6) NOT NULL COMMENT 'Y编号',
  `xyNumber` varchar(20) DEFAULT NULL COMMENT '编号',
  `specs` varchar(40) DEFAULT NULL COMMENT '规格',
  `price` int(11) DEFAULT NULL COMMENT '价格',
  `reserveStatus` varchar(100) DEFAULT NULL COMMENT '预定状态',
  `saleStatus` varchar(100) DEFAULT NULL COMMENT '销售状态',
  `repairStatus` varchar(100) DEFAULT NULL COMMENT '修复状态',
  `intoStatus` varchar(100) DEFAULT NULL COMMENT '入住状态',
  `cardno` varchar(40) DEFAULT '' COMMENT '卡号',
  `startDate` datetime DEFAULT NULL COMMENT '开始日期',
  `endDate` datetime DEFAULT NULL COMMENT '结束日期',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `isDeleted` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否删除',
  `buyer` varchar(20) DEFAULT NULL COMMENT '购墓人',
  `deceased` varchar(100) DEFAULT NULL COMMENT '安葬者',
  `contacts` varchar(200) DEFAULT NULL COMMENT '联系人',
  `transferOutStatus` varchar(100) DEFAULT NULL COMMENT '迁出状态',
  PRIMARY KEY (`idRoom`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=1000000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Table structure for sale
-- ----------------------------
DROP TABLE IF EXISTS `sale`;
CREATE TABLE `sale` (
  `idSale` bigint(20) NOT NULL AUTO_INCREMENT,
  `idRoom` bigint(20) NOT NULL,
  `serialNo` varchar(6) DEFAULT NULL COMMENT '编号',
  `realPrice` int(11) DEFAULT NULL COMMENT '实际价格',
  `payee` varchar(20) DEFAULT NULL COMMENT '收款人',
  `payer` varchar(20) DEFAULT NULL COMMENT '付款人',
  `payerPhone` varchar(40) DEFAULT '' COMMENT '账户电话',
  `payerIDCard` varchar(40) DEFAULT NULL COMMENT '付款人身份证号',
  `remark` varchar(50) DEFAULT NULL COMMENT '备注',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `isDeleted` smallint(1) unsigned zerofill NOT NULL DEFAULT '0' COMMENT '是否删除',
  PRIMARY KEY (`idSale`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=2000000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;



-- ----------------------------
-- Table structure for adminfee
-- ----------------------------
DROP TABLE IF EXISTS `adminfee`;
CREATE TABLE `adminfee` (
  `idAdminfee` bigint(20) NOT NULL AUTO_INCREMENT,
  `idRoom` bigint(20) NOT NULL,
  `termYears` int(11) DEFAULT NULL COMMENT '缴费年限',
  `startDate` datetime DEFAULT NULL COMMENT '开始日期',
  `endDate` datetime DEFAULT NULL COMMENT '结束日期',
  `payAmount` int(11) DEFAULT NULL COMMENT '收款金额',
  `payer` varchar(20) DEFAULT NULL COMMENT '付款人',
  `payePrhone` varchar(40) DEFAULT '' COMMENT '付款人电话',
  `payerIDCard` varchar(40) DEFAULT NULL COMMENT '付款人身份证号',
  `remark` varchar(50) DEFAULT NULL COMMENT '备注',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `isDeleted` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否删除',
  PRIMARY KEY (`idAdminfee`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=4000000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Table structure for buried
-- ----------------------------
DROP TABLE IF EXISTS `buried`;
CREATE TABLE `buried` (
  `idBuried` bigint(20) NOT NULL AUTO_INCREMENT,
  `idRoom` bigint(20) NOT NULL,
  `deceased` varchar(100) DEFAULT NULL COMMENT '安葬者',
  `deceasedIDCard` varchar(40) DEFAULT NULL COMMENT '安葬者身份证号',
  `deceasedRelation` varchar(20) DEFAULT NULL COMMENT '逝者关系',
  `burialDate` datetime DEFAULT NULL COMMENT '下葬日期',
  `contacts` varchar(20) DEFAULT NULL COMMENT '联系人',
  `contactsphone` varchar(40) DEFAULT '' COMMENT '联系人电话',
  `contactsIDCard` varchar(40) DEFAULT NULL COMMENT '联系人身份证号',
  `remark` varchar(255) DEFAULT NULL COMMENT '备注',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  `isDeleted` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否删除',
  PRIMARY KEY (`idBuried`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=3000000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Table structure for contacts
-- ----------------------------
DROP TABLE IF EXISTS `contacts`;
CREATE TABLE `contacts` (
  `idContacts` bigint(20) NOT NULL AUTO_INCREMENT,
  `idRoom` bigint(20) NOT NULL,
  `contacts` varchar(20) DEFAULT NULL COMMENT '联系人',
  `contactsPhone` varchar(40) DEFAULT '' COMMENT '联系电话',
  `contactsIDCard` varchar(40) DEFAULT NULL COMMENT '身份证号',
  `remark` varchar(255) DEFAULT NULL COMMENT '备注',
  `isDeleted` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否删除',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  PRIMARY KEY (`idContacts`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=5000000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;


-- ----------------------------
-- Table structure for period_change
-- ----------------------------
DROP TABLE IF EXISTS `period_change`;
CREATE TABLE `period_change` (
  `idChange` bigint(20) NOT NULL AUTO_INCREMENT,
  `idRoom` bigint(20) NOT NULL,
  `oldEndDate` datetime DEFAULT NULL COMMENT '原结束日期',
  `newEndDate` datetime DEFAULT NULL COMMENT '新结束日期',
  `isDeleted` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否删除',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  `reason` varchar(100) DEFAULT NULL COMMENT '原因',
  PRIMARY KEY (`idChange`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=6000000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Table structure for receipt_config
-- ----------------------------
DROP TABLE IF EXISTS `receipt_config`;
CREATE TABLE `receipt_config` (
  `idConfig` bigint(20) NOT NULL AUTO_INCREMENT,
  `prefix` varchar(40) DEFAULT NULL COMMENT '单据前缀',
  `region` varchar(40) DEFAULT NULL COMMENT '区域名称',
  `phone` varchar(40) DEFAULT '' COMMENT '账户电话',
  `address` varchar(200) DEFAULT '' COMMENT '单位地址',
  PRIMARY KEY (`idConfig`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=183 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Table structure for reserve
-- ----------------------------
DROP TABLE IF EXISTS `reserve`;
CREATE TABLE `reserve` (
  `idReserve` bigint(20) NOT NULL AUTO_INCREMENT,
  `idRoom` bigint(20) NOT NULL,
  `isDeleted` smallint(1) unsigned zerofill NOT NULL DEFAULT '0' COMMENT '是否删除',
  `liaison` varchar(20) DEFAULT NULL COMMENT '联系人',
  `liaisonPhone` varchar(20) NOT NULL DEFAULT '' COMMENT '联系人电话',
  `operator` varchar(40) NOT NULL DEFAULT '' COMMENT '操作人名',
  `remark` varchar(50) DEFAULT NULL COMMENT '备注',
  `modifyDate` datetime NOT NULL COMMENT '修改日期',
  `createDate` datetime NOT NULL COMMENT '创建日期',
  PRIMARY KEY (`idReserve`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=7000000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- Table structure for transfer_out
-- ----------------------------
DROP TABLE IF EXISTS `transfer_out`;
CREATE TABLE `transfer_out` (
  `idTransfer` bigint(20) NOT NULL AUTO_INCREMENT,
  `idRoom` bigint(20) NOT NULL,
  `transferOutDate` datetime DEFAULT NULL COMMENT '迁出日期',
  `destination` varchar(100) DEFAULT NULL COMMENT '迁往何处',
  `reason` varchar(100) DEFAULT NULL COMMENT '原因',
  `contacts` varchar(20) DEFAULT NULL COMMENT '联系人',
  `contactsphone` varchar(40) DEFAULT '' COMMENT '联系人电话',
  `isDeleted` smallint(1) unsigned zerofill DEFAULT '0' COMMENT '是否删除',
  `operator` varchar(40) DEFAULT '' COMMENT '操作人名',
  `modifyDate` datetime DEFAULT NULL COMMENT '修改日期',
  `createDate` datetime DEFAULT NULL COMMENT '创建日期',
  PRIMARY KEY (`idTransfer`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=8000000 DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- ----------------------------
-- View structure for v_region_park
-- ----------------------------
DROP VIEW IF EXISTS `v_region_park`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v_region_park` AS select distinct `a`.`park` AS `park`,`a`.`region` AS `region` from `room` `a` order by `a`.`region`;

-- ----------------------------
-- Table structure for login_session
-- ----------------------------
DROP TABLE IF EXISTS `login_session`;
CREATE TABLE `login_session` (
  `phone` varchar(20) NOT NULL COMMENT '登录手机号',
  `exp` varchar(20) DEFAULT NULL COMMENT 'token到期时间戳',
  `updateTime` datetime DEFAULT NULL COMMENT '更新时间',
  PRIMARY KEY (`phone`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC COMMENT='登录态会话表';

-- ----------------------------
-- Table structure for device
-- ----------------------------
DROP TABLE IF EXISTS `device`;
CREATE TABLE `device` (
  `idDevice` int NOT NULL AUTO_INCREMENT COMMENT '设备ID',
  `deviceHash` varchar(64) NOT NULL COMMENT '设备哈希(SHA256:硬盘序列号+主板序列号+MachineGuid)',
  `deviceName` varchar(100) DEFAULT NULL COMMENT '电脑名',
  `useStatus` tinyint DEFAULT '1' COMMENT '启用状态:1启用/0停用',
  `createDate` datetime DEFAULT NULL COMMENT '登记时间',
  `updateDate` datetime DEFAULT NULL COMMENT '更新时间',
  PRIMARY KEY (`idDevice`),
  UNIQUE KEY `uk_deviceHash` (`deviceHash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC COMMENT='登录设备白名单表';

SET FOREIGN_KEY_CHECKS = 1;
