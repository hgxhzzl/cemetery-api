//用于生成和解析token
const jwt = require('jsonwebtoken');
const config = require('./config');
const signkey = config.auth.jwtSecret;
//生成token
// isAccount 进入 payload 供授权层区分平台管理员,旧 token 无该字段时安全默认非管理员 20260917 越权收口,
exports.setToken = function (Phone,UserName,Database,UserId,IsAccount) {
	return jwt.sign({ phone:Phone,userName:UserName,dataBase:Database,userId:UserId,isAccount:IsAccount},
		 signkey, { expiresIn: config.auth.tokenExpiresIn });
}
//解析token
exports.verToken = function (token) {
	return new Promise((resolve, reject) => {
		var info = jwt.verify(token.split(' ')[1], signkey);
		resolve(info);
	})
}
exports.verTokenNew = function (token) {
	return jwt.verify(token.split(' ')[1], signkey);
}


