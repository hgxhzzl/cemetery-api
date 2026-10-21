//用于生成和解析token
const jwt = require('jsonwebtoken');
const config = require('./config');
const signkey = config.auth.jwtSecret;
// 固定签名算法:验签不传 algorithms 时 jsonwebtoken 按 token 头部声明的算法选密钥校验方式,
// 担心算法混乱(如 alg=none / RS256 拿 HS 公钥当密钥)误接受伪造 token;本文件是全仓唯一验签入口,口径在此单点固定 20261021 审查修复 中D,
const JWT_ALGORITHMS = ['HS256'];
//生成token
// isAccount 进入 payload 供授权层区分平台管理员,旧 token 无该字段时安全默认非管理员 20260917 越权收口,
exports.setToken = function (Phone,UserName,Database,UserId,IsAccount) {
	return jwt.sign({ phone:Phone,userName:UserName,dataBase:Database,userId:UserId,isAccount:IsAccount},
		 signkey, { algorithm: JWT_ALGORITHMS[0], expiresIn: config.auth.tokenExpiresIn });
}
//解析token
exports.verToken = function (token) {
	return new Promise((resolve, reject) => {
		var info = jwt.verify(token.split(' ')[1], signkey, { algorithms: JWT_ALGORITHMS });
		resolve(info);
	})
}
exports.verTokenNew = function (token) {
	return jwt.verify(token.split(' ')[1], signkey, { algorithms: JWT_ALGORITHMS });
}


